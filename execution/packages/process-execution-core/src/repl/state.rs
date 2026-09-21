use crate::{Error, Result, api::*, native::backend};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    net::tcp::OwnedWriteHalf,
    sync::{Mutex as AsyncMutex, Notify},
};
use uuid::Uuid;

pub(crate) struct ReplSession {
    pub handle: Uuid,
    pub cwd: std::path::PathBuf,
    pub env: std::collections::BTreeMap<String, String>,
    pub exited_at: Mutex<Option<Instant>>,
    pub language: Language,
    pub control: Arc<dyn backend::Control>,
    pub writer: AsyncMutex<OwnedWriteHalf>,
    pub queue: AsyncMutex<()>,
    pub exited: AtomicBool,
    pub exit_notify: Notify,
    pub executions: Mutex<HashMap<Uuid, Arc<CellExecution>>>,
    pub background: Mutex<Vec<Value>>,
    pub background_truncated: AtomicBool,
    pub buffered: AtomicUsize,
    pub buffer_limit: usize,
}
pub(crate) struct CellExecution {
    pub id: Uuid,
    pub state: Mutex<CellState>,
    pub changed: Notify,
    pub collect: AsyncMutex<()>,
    pub origin_request: Mutex<Option<String>>,
    pub helpers_cancel: tokio_util::sync::CancellationToken,
}
pub(crate) struct CellState {
    pub status: String,
    pub integrity: String,
    pub cells: Vec<CellStatus>,
    pub events: Vec<Value>,
    pub bytes: usize,
    pub truncated: bool,
    pub finished_at: Option<Instant>,
    pub expired: bool,
}
impl CellExecution {
    pub fn new(cells: &[Cell]) -> Self {
        Self {
            id: Uuid::new_v4(),
            state: Mutex::new(CellState {
                status: "queued".into(),
                integrity: "preserved".into(),
                cells: cells
                    .iter()
                    .map(|c| CellStatus {
                        id: c.id.clone(),
                        status: "queued".into(),
                    })
                    .collect(),
                events: Vec::new(),
                bytes: 0,
                truncated: false,
                finished_at: None,
                expired: false,
            }),
            changed: Notify::new(),
            collect: AsyncMutex::new(()),
            origin_request: Mutex::new(None),
            helpers_cancel: tokio_util::sync::CancellationToken::new(),
        }
    }
    pub fn is_done(&self) -> bool {
        self.state.lock().unwrap().finished_at.is_some()
    }
    pub fn set_running(&self) {
        self.state.lock().unwrap().status = "running".into();
        self.changed.notify_waiters();
    }
    pub fn finish(&self, status: &str, integrity: &str) {
        let mut state = self.state.lock().unwrap();
        if state.finished_at.is_some() {
            return;
        }
        state.status = status.into();
        state.integrity = integrity.into();
        state.finished_at = Some(Instant::now());
        for cell in &mut state.cells {
            if cell.status == "queued" {
                cell.status = "skipped".into();
            } else if cell.status == "running" {
                cell.status = status.into();
            }
        }
        drop(state);
        self.changed.notify_waiters();
    }
}
impl ReplSession {
    pub async fn send(&self, message: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(message).map_err(|e| Error::invalid(e.to_string()))?;
        bytes.push(b'\n');
        self.writer
            .lock()
            .await
            .write_all(&bytes)
            .await
            .map_err(Into::into)
    }
    pub fn kill(&self) {
        for work in self.executions.lock().unwrap().values() {
            work.helpers_cancel.cancel();
        }
        let _ = self.control.kill();
    }
    pub async fn close(&self) {
        self.kill();
        loop {
            let changed = self.exit_notify.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.exited.load(Ordering::Acquire) {
                break;
            }
            changed.await;
        }
    }
    pub fn expired(&self, ttl: Duration) -> bool {
        self.exited_at
            .lock()
            .unwrap()
            .is_some_and(|at| at.elapsed() >= ttl)
    }
    pub fn mark_lost(&self) {
        *self.exited_at.lock().unwrap() = Some(Instant::now());
        self.exited.store(true, Ordering::Release);
        for work in self.executions.lock().unwrap().values() {
            work.helpers_cancel.cancel();
            work.finish("lost", "lost");
        }
        self.exit_notify.notify_waiters();
    }
    pub fn event(&self, execution: Option<Uuid>, event: Value) {
        let size = serde_json::to_vec(&event).map_or(0, |v| v.len());
        let work = execution.and_then(|id| self.executions.lock().unwrap().get(&id).cloned());
        if self
            .buffered
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(size).filter(|n| *n <= self.buffer_limit)
            })
            .is_err()
        {
            if let Some(work) = work {
                work.state.lock().unwrap().truncated = true;
            } else {
                self.background_truncated.store(true, Ordering::Release);
            }
            return;
        }
        if let Some(work) = work {
            let mut state = work.state.lock().unwrap();
            if state.expired {
                self.buffered.fetch_sub(size, Ordering::AcqRel);
                return;
            }
            state.events.push(event);
            state.bytes += size;
            drop(state);
            work.changed.notify_waiters();
        } else {
            self.background.lock().unwrap().push(event);
        }
    }
    pub fn sweep(&self, ttl: Duration) {
        for work in self.executions.lock().unwrap().values() {
            let mut state = work.state.lock().unwrap();
            if state.finished_at.is_some_and(|at| at.elapsed() >= ttl) && !state.expired {
                state.events.clear();
                self.buffered.fetch_sub(state.bytes, Ordering::AcqRel);
                state.bytes = 0;
                state.expired = true;
            }
        }
    }
}
impl Drop for ReplSession {
    fn drop(&mut self) {
        self.kill();
    }
}
