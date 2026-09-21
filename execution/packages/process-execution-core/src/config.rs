use crate::{Error, Result};
use std::{path::PathBuf, time::Duration};

/// All time-based retention is explicit and configurable. Live sessions have no
/// idle expiry. Limits apply to the entire runtime.
#[derive(Debug, Clone)]
pub struct Retention {
    pub unread_results: Duration,
    pub delivered_receipts: Duration,
    pub artifacts: Duration,
    pub sweep_interval: Duration,
}
impl Default for Retention {
    fn default() -> Self {
        Self {
            unread_results: Duration::from_secs(86400),
            delivered_receipts: Duration::from_secs(86400),
            artifacts: Duration::from_secs(86400),
            sweep_interval: Duration::from_secs(30),
        }
    }
}
#[derive(Debug, Clone)]
pub struct Config {
    pub cwd: PathBuf,
    pub artifact_directory: PathBuf,
    pub python: PathBuf,
    pub node: PathBuf,
    pub retention: Retention,
    pub max_processes: usize,
    pub max_repls: usize,
    pub max_requests: usize,
    pub max_pending_requests: usize,
    pub max_request_bytes: usize,
    pub max_result_bytes: usize,
    pub max_repl_output_bytes: usize,
    pub max_output_bytes: usize,
    pub max_session_output_bytes: usize,
    pub max_receipt_bytes: usize,
    pub max_file_bytes: usize,
    pub max_image_pixels: u64,
    pub max_cells: usize,
    pub max_artifact_bytes: u64,
    pub max_wait: Duration,
    pub termination_grace: Duration,
    pub output_drain_timeout: Duration,
    pub repl_startup_timeout: Duration,
    pub interrupt_grace: Duration,
}
impl Config {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        let cwd = cwd.into();
        Self {
            artifact_directory: cwd.join(".execution-artifacts"),
            cwd,
            python: "python3".into(),
            node: "node".into(),
            retention: Retention::default(),
            max_processes: 64,
            max_repls: 8,
            max_requests: 100_000,
            max_pending_requests: 128,
            max_request_bytes: 8 * 1024 * 1024,
            max_result_bytes: 8 * 1024 * 1024,
            max_repl_output_bytes: 7 * 1024 * 1024,
            max_output_bytes: 1024 * 1024,
            max_session_output_bytes: 1024 * 1024,
            max_receipt_bytes: 64 * 1024 * 1024,
            max_file_bytes: 5 * 1024 * 1024,
            max_image_pixels: 40_000_000,
            max_cells: 32,
            max_artifact_bytes: 128 * 1024 * 1024,
            max_wait: Duration::from_secs(300),
            termination_grace: Duration::from_secs(2),
            output_drain_timeout: Duration::from_secs(1),
            repl_startup_timeout: Duration::from_secs(15),
            interrupt_grace: Duration::from_secs(2),
        }
    }
    pub(crate) fn validate(&self) -> Result<()> {
        if !self.cwd.is_absolute() || !self.cwd.is_dir() || !self.artifact_directory.is_absolute() {
            return Err(Error::invalid(
                "cwd must be an absolute directory; artifact_directory must be absolute",
            ));
        }
        if [
            self.max_processes,
            self.max_repls,
            self.max_requests,
            self.max_pending_requests,
            self.max_request_bytes,
            self.max_result_bytes,
            self.max_repl_output_bytes,
            self.max_output_bytes,
            self.max_session_output_bytes,
            self.max_receipt_bytes,
            self.max_file_bytes,
            self.max_cells,
        ]
        .contains(&0)
            || self.max_file_bytes > crate::native::MAX_FILE_BYTES
            || self.max_image_pixels == 0
            || self.max_artifact_bytes == 0
            || self.max_wait.is_zero()
            || self.max_wait > Duration::from_secs(300)
            || self.retention.sweep_interval.is_zero()
            || self.repl_startup_timeout.is_zero()
            || self.output_drain_timeout.is_zero()
            || self.interrupt_grace.is_zero()
            || self.termination_grace > Duration::from_secs(30)
            || self.max_output_bytes > self.max_session_output_bytes
            || self.max_receipt_bytes < self.max_result_bytes
            || self.max_result_bytes < self.max_repl_output_bytes.saturating_add(65536)
            || self.max_result_bytes
                < self
                    .max_output_bytes
                    .saturating_mul(6)
                    .saturating_add(65536)
            || self.max_result_bytes
                < self
                    .max_file_bytes
                    .saturating_add(2)
                    .saturating_div(3)
                    .saturating_mul(4)
                    .saturating_add(65536)
            || self.max_result_bytes < crate::native::MAX_PATCH_RESULT_BYTES + 65536
            || self.max_cells > 128
        {
            return Err(Error::invalid("invalid resource or time limits"));
        }
        Ok(())
    }
}
