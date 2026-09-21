use crate::{Error, ErrorCode, Result};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

pub(crate) struct Receipt {
    pub fingerprint: Vec<u8>,
    pub cancel: CancellationToken,
    pub result: watch::Sender<Option<Result<Value>>>,
    pub delivered: Mutex<Option<Instant>>,
}
pub(crate) struct Ledger {
    pub entries: HashMap<String, Arc<Receipt>>,
    pub bytes: usize,
    pub pending: usize,
}
impl Ledger {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            pending: 0,
        }
    }
    pub fn sweep(&mut self, ttl: std::time::Duration) {
        for receipt in self.entries.values() {
            let expired = receipt
                .delivered
                .lock()
                .unwrap()
                .is_some_and(|at| at.elapsed() >= ttl);
            if expired {
                let old = receipt.result.send_replace(Some(Err(Error::new(
                    ErrorCode::ResultExpired,
                    "request result expired; this identity cannot execute again",
                ))));
                let old_len = old.as_ref().map(size).unwrap_or(0);
                let new_len = receipt.result.borrow().as_ref().map(size).unwrap_or(0);
                self.bytes = self.bytes.saturating_sub(old_len).saturating_add(new_len);
                *receipt.delivered.lock().unwrap() = None;
            }
        }
    }
}
pub(crate) fn size(value: &Result<Value>) -> usize {
    serde_json::to_vec(value).map_or(1024, |v| v.len())
}
pub(crate) async fn wait(receipt: &Receipt) -> Result<Value> {
    let mut rx = receipt.result.subscribe();
    loop {
        if let Some(result) = rx.borrow().clone() {
            return result;
        }
        rx.changed()
            .await
            .map_err(|_| Error::new(ErrorCode::Unavailable, "request owner stopped"))?;
    }
}
