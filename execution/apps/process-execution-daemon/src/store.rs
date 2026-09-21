use crate::{
    Result,
    config::Config,
    protocol::{self, Incoming, MAX_RESULT},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credential {
    pub gateway_url: String,
    pub user_id: String,
    pub machine_id: Uuid,
    pub token: String,
}
impl Credential {
    pub fn load(path: &Path) -> Result<Self> {
        Ok(serde_json::from_slice(
            &fs::read(path.join("credential.json"))
                .map_err(|_| "machine is not registered; run register or configure first")?,
        )?)
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        if path.join("credential.json").exists() {
            let old = Self::load(path)?;
            if (old.machine_id, &old.user_id, &old.gateway_url)
                != (self.machine_id, &self.user_id, &self.gateway_url)
            {
                return Err("this state directory belongs to another machine or gateway; use a separate --state-dir".into());
            }
        }
        write_json(&path.join("credential.json"), self)
    }
}
pub struct Lock {
    _file: File,
}
impl Lock {
    pub fn acquire(directory: &Path) -> Result<Self> {
        private_directory(directory)?;
        let file = lock_file(directory)?;
        file.try_lock().map_err(
            |_| "daemon is already running or another command is changing this state directory",
        )?;
        Ok(Self { _file: file })
    }
}
pub fn running(directory: &Path) -> Result<bool> {
    if !directory.exists() {
        return Ok(false);
    }
    let file = lock_file(directory)?;
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(std::fs::TryLockError::WouldBlock) => Ok(true),
        Err(e) => Err(e.into()),
    }
}
fn lock_file(directory: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("daemon.lock"))?)
}
pub fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(windows)]
    crate::windows::private_directory(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or("state file has no parent")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn status(directory: &Path, state: &str, generation: Uuid, detail: &str) -> Result<()> {
    write_json(
        &directory.join("status.json"),
        &json!({"state":state,"runtimeGeneration":generation,"pid":std::process::id(),"updatedAt":now(),"detail":detail}),
    )
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Metadata {
    pub request_id: String,
    pub request_hash: String,
    pub runtime_generation: Uuid,
    pub native: bool,
}
pub struct Delivery {
    pub key: String,
    pub frame: Value,
    pub attempts: u32,
}
pub enum Admission {
    New,
    Duplicate,
    Conflict,
    Capacity,
    Expired,
}
pub struct Journal {
    db: Mutex<Connection>,
}
impl Journal {
    pub fn open(directory: &Path) -> Result<Self> {
        let db = Connection::open(directory.join("journal.sqlite"))?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS requests (
            key TEXT PRIMARY KEY, hash TEXT NOT NULL, input_hash TEXT NOT NULL, metadata TEXT NOT NULL,
            ticket TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT, result_hash TEXT, delivery_id TEXT,
            created INTEGER NOT NULL, completed INTEGER, acked INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL, reason TEXT);
          CREATE INDEX IF NOT EXISTS deliveries ON requests(delivery_id);")?;
        let columns: Vec<String> = db
            .prepare("PRAGMA table_info(requests)")?
            .query_map([], |row| row.get(1))?
            .collect::<rusqlite::Result<_>>()?;
        if !columns.iter().any(|c| c == "execution_ms") {
            db.execute("ALTER TABLE requests ADD COLUMN execution_ms REAL", [])?;
        }
        if !columns.iter().any(|c| c == "first_sent") {
            db.execute("ALTER TABLE requests ADD COLUMN first_sent INTEGER", [])?;
        }
        if !columns.iter().any(|c| c == "last_delivery_error") {
            db.execute(
                "ALTER TABLE requests ADD COLUMN last_delivery_error TEXT",
                [],
            )?;
        }
        Ok(Self { db: Mutex::new(db) })
    }
    pub fn admit(&self, req: &Incoming, native: bool, config: &Config) -> Result<Admission> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let input_hash = protocol::hash(&req.operation)?;
        let old: Option<(String, String, String)> = tx
            .query_row(
                "SELECT hash,input_hash,state FROM requests WHERE key=?",
                [req.key()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((hash, input, state)) = old {
            if hash != req.request_hash || input != input_hash {
                return Ok(Admission::Conflict);
            }
            if state == "expired" {
                return Ok(Admission::Expired);
            }
            // A refreshed return ticket may repair expired delivery authorization.
            tx.execute("UPDATE requests SET ticket=?, next_attempt=0, state=CASE WHEN state IN ('delivered','quarantined') THEN 'pending' ELSE state END, reason=NULL WHERE key=?", params![req.return_ticket, req.key()])?;
            tx.commit()?;
            return Ok(Admission::Duplicate);
        }
        let (count, active, bytes): (u64,u64,u64) = tx.query_row("SELECT count(*), COALESCE(sum(state='active'),0), COALESCE(sum(bytes),0) FROM requests", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if count >= config.max_journal_requests as u64
            || active >= config.max_active_requests as u64
            || bytes + MAX_RESULT as u64 > config.max_outbox_bytes
        {
            return Ok(Admission::Capacity);
        }
        let metadata = Metadata {
            request_id: req.request_id.clone(),
            request_hash: req.request_hash.clone(),
            runtime_generation: req.runtime_generation,
            native,
        };
        tx.execute("INSERT INTO requests(key,hash,input_hash,metadata,ticket,state,created,bytes) VALUES(?,?,?,?,?,'active',?,?)", params![req.key(),req.request_hash,input_hash,serde_json::to_string(&metadata)?,req.return_ticket,now(),MAX_RESULT as u64])?;
        tx.commit()?;
        Ok(Admission::New)
    }
    pub fn complete(&self, key: &str, outcome: &Value) -> Result<()> {
        self.complete_timed(key, outcome, None)
    }
    pub fn complete_timed(
        &self,
        key: &str,
        outcome: &Value,
        execution_ms: Option<f64>,
    ) -> Result<()> {
        let result_hash = protocol::hash(outcome)?;
        let encoded = serde_json_canonicalizer::to_string(outcome)?;
        let db = self.db.lock().unwrap();
        let request_hash: String =
            db.query_row("SELECT hash FROM requests WHERE key=?", [key], |r| r.get(0))?;
        let delivery_id =
            protocol::hash(&json!({"requestHash":request_hash,"resultHash":result_hash}))?;
        db.execute("UPDATE requests SET state='pending',outcome=?,result_hash=?,delivery_id=?,completed=?,bytes=?,execution_ms=?,next_attempt=0 WHERE key=? AND state='active'", params![encoded,result_hash,delivery_id,now(),encoded.len(),execution_ms,key])?;
        Ok(())
    }
    pub fn recover(&self) -> Result<()> {
        let keys: Vec<String> = {
            let db = self.db.lock().unwrap();
            db.prepare("SELECT key FROM requests WHERE state='active'")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for key in keys {
            self.complete(&key, &protocol::error("DAEMON_RESTARTED", "Daemon stopped before recording a result. Effects may have occurred; the operation was not rerun.", true))?;
        }
        Ok(())
    }
    pub fn next(&self) -> Result<Option<Delivery>> {
        let db = self.db.lock().unwrap();
        let row: Option<(String,String,String,String,u32)> = db.query_row("SELECT key,ticket,outcome,delivery_id,attempts FROM requests WHERE state='pending' AND next_attempt<=? ORDER BY next_attempt,created LIMIT 1", [now()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        row.map(|(key,ticket,outcome,id,attempts)| Ok(Delivery { key, attempts, frame:json!({"type":"result","returnTicket":ticket,"outcome":serde_json::from_str::<Value>(&outcome)?,"deliveryId":id}) })).transpose()
    }
    pub fn attempted(&self, key: &str, delay_ms: u64) -> Result<()> {
        self.db.lock().unwrap().execute("UPDATE requests SET attempts=attempts+1,next_attempt=?,first_sent=COALESCE(first_sent,?) WHERE key=? AND state='pending'", params![now().saturating_add(delay_ms.min(i64::MAX as u64) as i64), now(), key])?;
        Ok(())
    }
    pub fn flushed(&self, key: &str, delay_ms: u64) -> Result<()> {
        self.db.lock().unwrap().execute(
            "UPDATE requests SET next_attempt=? WHERE key=? AND state='pending'",
            params![
                now().saturating_add(delay_ms.min(i64::MAX as u64) as i64),
                key
            ],
        )?;
        Ok(())
    }
    pub fn ack(&self, frame: &Value) -> Result<Option<Metadata>> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let row: Option<(String, String, String, String)> = tx
            .query_row(
                "SELECT key,metadata,hash,result_hash FROM requests WHERE delivery_id=? AND outcome IS NOT NULL AND state != 'expired'",
                [frame["deliveryId"].as_str().unwrap_or("")],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((key, metadata, hash, result_hash)) = row else {
            return Ok(None);
        };
        let metadata: Metadata = serde_json::from_str(&metadata)?;
        if frame["requestId"] != metadata.request_id
            || frame["requestHash"] != hash
            || frame["resultHash"] != result_hash
        {
            return Err("gateway acknowledgement does not match saved result".into());
        }
        tx.execute(
            "UPDATE requests SET state='delivered',acked=COALESCE(acked,?),reason=NULL WHERE key=?",
            params![now(), key],
        )?;
        tx.commit()?;
        Ok(Some(metadata))
    }
    pub fn nack(&self, id: &str, code: &str, retryable: bool) -> Result<()> {
        self.db.lock().unwrap().execute("UPDATE requests SET reason=?,last_delivery_error=?,state=CASE WHEN ? THEN state ELSE 'quarantined' END WHERE delivery_id=? AND state='pending'", params![code,code,retryable,id])?;
        Ok(())
    }
    pub fn sweep(&self, current: Uuid, config: &Config) -> Result<()> {
        let db = self.db.lock().unwrap();
        let horizon = now().saturating_sub(millis(config.delivery_horizon_seconds));
        db.execute("UPDATE requests SET state='quarantined',reason='DELIVERY_HORIZON_EXCEEDED' WHERE state='pending' AND created<?", [horizon])?;
        let before = now().saturating_sub(millis(config.delivered_retention_seconds));
        db.execute("UPDATE requests SET state='expired',outcome=NULL,ticket='',bytes=0 WHERE state='delivered' AND acked<?", [before])?;
        // Current-generation tombstones never disappear: expired IDs cannot re-execute.
        db.execute("DELETE FROM requests WHERE state='expired' AND json_extract(metadata,'$.runtime_generation') != ?", [current.to_string()])?;
        Ok(())
    }
    pub fn summary(&self) -> Result<Vec<(String, u64)>> {
        Ok(self
            .db
            .lock()
            .unwrap()
            .prepare("SELECT state,count(*) FROM requests GROUP BY state ORDER BY state")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn failures(&self) -> Result<Vec<(String, String, String)>> {
        Ok(self.db.lock().unwrap().prepare("SELECT json_extract(metadata,'$.request_id'),COALESCE(delivery_id,''),COALESCE(reason,'') FROM requests WHERE state='quarantined' ORDER BY created LIMIT 100")?.query_map([], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<rusqlite::Result<_>>()?)
    }
    pub fn discard(&self, id: &str) -> Result<bool> {
        Ok(self.db.lock().unwrap().execute("UPDATE requests SET state='expired',outcome=NULL,ticket='',bytes=0,reason='MANUALLY_DISCARDED' WHERE delivery_id=? AND state='quarantined'", [id])? > 0)
    }
    pub fn retry(&self, id: &str) -> Result<bool> {
        Ok(self.db.lock().unwrap().execute("UPDATE requests SET state='pending',next_attempt=0,created=?,reason=NULL WHERE delivery_id=? AND state='quarantined'", params![now(),id])? > 0)
    }
}
fn millis(seconds: u64) -> i64 {
    seconds.saturating_mul(1000).min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(generation: Uuid) -> Incoming {
        serde_json::from_value(json!({"type":"request","protocolVersion":1,"dispatchId":Uuid::new_v4(),"requestId":"one","requestHash":"a".repeat(64),"runtimeGeneration":generation,"operation":{"operation":"runtime.capabilities","params":{}},"returnTicket":"saved-ticket"})).unwrap()
    }
    #[test]
    fn crash_recovery_does_not_rerun_and_requires_matching_ack() {
        let dir = tempfile::tempdir().unwrap();
        let generation = Uuid::new_v4();
        let req = request(generation);
        {
            let j = Journal::open(dir.path()).unwrap();
            assert!(matches!(
                j.admit(&req, false, &Config::default()).unwrap(),
                Admission::New
            ));
        }
        let j = Journal::open(dir.path()).unwrap();
        j.recover().unwrap();
        let delivery = j.next().unwrap().unwrap();
        assert_eq!(
            delivery.frame["outcome"]["error"]["code"],
            "DAEMON_RESTARTED"
        );
        assert_eq!(delivery.frame["outcome"]["error"]["uncertain"], true);
        assert!(matches!(
            j.admit(&req, false, &Config::default()).unwrap(),
            Admission::Duplicate
        ));
        let mut changed = req.clone();
        changed.operation["params"] = json!({"cwd":"/tmp"});
        assert!(matches!(
            j.admit(&changed, false, &Config::default()).unwrap(),
            Admission::Conflict
        ));
        let mut ack = json!({"deliveryId":delivery.frame["deliveryId"],"requestId":"one","requestHash":req.request_hash,"resultHash":"wrong"});
        assert!(j.ack(&ack).is_err());
        ack["resultHash"] = json!(protocol::hash(&delivery.frame["outcome"]).unwrap());
        assert!(j.ack(&ack).unwrap().is_some());
        let config = Config {
            delivered_retention_seconds: 0,
            ..Config::default()
        };
        std::thread::sleep(std::time::Duration::from_millis(2));
        j.sweep(generation, &config).unwrap();
        assert!(matches!(
            j.admit(&req, false, &config).unwrap(),
            Admission::Expired
        ));
        assert!(j.ack(&ack).unwrap().is_none());
        assert!(j.next().unwrap().is_none());
        j.sweep(Uuid::new_v4(), &config).unwrap();
        assert!(j.summary().unwrap().is_empty());
    }
    #[test]
    fn capacity_is_reserved_before_execution_and_permanent_failures_are_retained() {
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::open(dir.path()).unwrap();
        let mut req = request(Uuid::new_v4());
        let c = Config {
            max_active_requests: 1,
            ..Config::default()
        };
        assert!(matches!(j.admit(&req, false, &c).unwrap(), Admission::New));
        req.request_id = "two".into();
        assert!(matches!(
            j.admit(&req, false, &c).unwrap(),
            Admission::Capacity
        ));
        req.request_id = "one".into();
        j.complete(&req.key(), &json!({"status":"ok","result":null}))
            .unwrap();
        let delivery = j.next().unwrap().unwrap();
        let id = delivery.frame["deliveryId"].as_str().unwrap();
        j.nack(id, "INVALID_TOKEN", false).unwrap();
        assert!(j.next().unwrap().is_none());
        assert_eq!(j.failures().unwrap().len(), 1);
        assert!(j.retry(id).unwrap());
        assert!(j.next().unwrap().is_some());
    }
    #[test]
    fn acknowledgement_window_starts_after_slow_upload_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::open(dir.path()).unwrap();
        let req = request(Uuid::new_v4());
        j.admit(&req, false, &Config::default()).unwrap();
        j.complete(&req.key(), &json!({"status":"ok","result":null}))
            .unwrap();
        // Simulate a send that consumed the original retry budget.
        j.attempted(&req.key(), 0).unwrap();
        assert!(j.next().unwrap().is_some());
        j.flushed(&req.key(), 10000).unwrap();
        assert!(j.next().unwrap().is_none());
        let attempts: u32 =
            j.db.lock()
                .unwrap()
                .query_row("SELECT attempts FROM requests", [], |r| r.get(0))
                .unwrap();
        assert_eq!(attempts, 1);
    }
    #[test]
    fn locks_exclude_another_runtime_and_private_files_are_written() {
        let dir = tempfile::tempdir().unwrap();
        let lock = Lock::acquire(dir.path()).unwrap();
        assert!(running(dir.path()).unwrap());
        assert!(Lock::acquire(dir.path()).is_err());
        drop(lock);
        assert!(!running(dir.path()).unwrap());
        write_json(&dir.path().join("sample.json"), &json!({"a":1})).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path().join("sample.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
