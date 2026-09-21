use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use url::Url;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub cwd: PathBuf,
    pub update_manifest_url: Option<String>,
    pub python: PathBuf,
    pub node: PathBuf,
    pub allow_insecure_loopback: bool,
    pub max_processes: usize,
    pub max_repls: usize,
    pub max_active_requests: usize,
    pub max_journal_requests: usize,
    pub max_outbox_bytes: u64,
    pub delivered_retention_seconds: u64,
    pub delivery_horizon_seconds: u64,
    pub core_unread_retention_seconds: u64,
    pub core_receipt_retention_seconds: u64,
    pub artifact_retention_seconds: u64,
    pub reconnect_min_ms: u64,
    pub reconnect_max_ms: u64,
    pub delivery_retry_ms: u64,
    pub delivery_ack_timeout_ms: u64,
    pub delivery_send_timeout_seconds: u64,
    pub heartbeat_seconds: u64,
    pub shutdown_seconds: u64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            cwd: directories::BaseDirs::new()
                .map(|b| b.home_dir().to_owned())
                .unwrap_or_else(|| PathBuf::from("/")),
            update_manifest_url: None,
            python: "python3".into(),
            node: "node".into(),
            allow_insecure_loopback: false,
            max_processes: 64,
            max_repls: 8,
            max_active_requests: 16,
            max_journal_requests: 100_000,
            max_outbox_bytes: 512 * 1024 * 1024,
            delivered_retention_seconds: 86400,
            delivery_horizon_seconds: 86400,
            core_unread_retention_seconds: 86400,
            core_receipt_retention_seconds: 86400,
            artifact_retention_seconds: 86400,
            reconnect_min_ms: 500,
            reconnect_max_ms: 30000,
            delivery_retry_ms: 1000,
            delivery_ack_timeout_ms: 10000,
            delivery_send_timeout_seconds: 60,
            heartbeat_seconds: 20,
            shutdown_seconds: 15,
        }
    }
}
impl Config {
    pub fn load(directory: &Path, override_path: Option<&Path>) -> Result<Self> {
        let path = override_path
            .map(Path::to_owned)
            .unwrap_or_else(|| directory.join("config.json"));
        let value: Self = if path.exists() {
            serde_json::from_slice(&std::fs::read(path)?)?
        } else if override_path.is_some() {
            return Err("configuration file not found".into());
        } else {
            Self::default()
        };
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<()> {
        if !self.cwd.is_absolute() || !self.cwd.is_dir() {
            return Err("cwd must be an existing absolute directory".into());
        }
        if self.max_processes == 0
            || self.max_repls == 0
            || self.max_active_requests == 0
            || self.max_active_requests > 256
            || self.max_journal_requests == 0
            || self.max_outbox_bytes < 8 * 1024 * 1024
            || self.reconnect_min_ms < 10
            || self.reconnect_max_ms < self.reconnect_min_ms
            || self.delivery_ack_timeout_ms < 10
            || self.delivery_send_timeout_seconds == 0
            || self.delivery_send_timeout_seconds > 300
            || self.delivery_retry_ms < 10
            || self.heartbeat_seconds == 0
            || self.heartbeat_seconds > 300
            || self.shutdown_seconds == 0
            || self.delivery_horizon_seconds == 0
        {
            return Err("invalid daemon capacity or timing configuration".into());
        }
        Ok(())
    }
    pub fn core(&self, state: &Path) -> process_execution_core::Config {
        let mut c = process_execution_core::Config::new(&self.cwd);
        c.artifact_directory = state.join("artifacts");
        c.max_processes = self.max_processes;
        c.max_repls = self.max_repls;
        c.python = self.python.clone();
        c.node = self.node.clone();
        c.retention.unread_results = Duration::from_secs(self.core_unread_retention_seconds);
        c.retention.delivered_receipts = Duration::from_secs(self.core_receipt_retention_seconds);
        c.retention.artifacts = Duration::from_secs(self.artifact_retention_seconds);
        c
    }
}
pub fn gateway(value: &str, insecure: bool) -> Result<Url> {
    let url = Url::parse(value)?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if (url.scheme() != "https" && !(insecure && local && url.scheme() == "http"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.host_str().is_none()
    {
        return Err(
            "gateway must be an HTTPS origin (HTTP loopback requires --allow-insecure-loopback)"
                .into(),
        );
    }
    Ok(url)
}
