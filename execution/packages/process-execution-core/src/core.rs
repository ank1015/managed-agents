use crate::{
    Error, ErrorCode, Result,
    api::*,
    config::Config,
    execution::ExecSession,
    native,
    receipts::{self, Ledger, Receipt},
    repl::ReplSession,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub struct ProcessExecutionCore {
    pub(crate) inner: Arc<Inner>,
}
pub(crate) struct Inner {
    pub config: Config,
    pub generation: Uuid,
    pub runtime: Arc<Runtime>,
    pub stopping: AtomicBool,
    pub runtime_directory: PathBuf,
}
// Shared by in-flight work without retaining Inner. Dropping the last core can
// therefore cancel the runtime even while yielded processes/interpreters live.
pub(crate) struct Runtime {
    pub native: native::ProcessExecutionCore,
    pub cancel: CancellationToken,
    pub ledger: Mutex<Ledger>,
    pub processes: Mutex<HashMap<Uuid, Arc<ExecSession>>>,
    pub repls: Mutex<HashMap<Uuid, Arc<ReplSession>>>,
    pub repl_creation: tokio::sync::Mutex<()>,
    pub artifacts: Mutex<Vec<(PathBuf, Instant)>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.runtime.cancel.cancel();
        for repl in self.runtime.repls.lock().unwrap().values() {
            repl.kill();
        }
        let _ = std::fs::remove_dir_all(&self.runtime_directory);
    }
}
impl ProcessExecutionCore {
    /// Construct inside a Tokio runtime. Interpreter availability is checked on creation.
    pub fn new(settings: Config) -> Result<Self> {
        settings.validate()?;
        let generation = Uuid::new_v4();
        let runtime_directory = settings
            .artifact_directory
            .join(format!("runtime-{generation}"));
        let mut config = native::Config::new(&settings.cwd);
        config.run_output_directory = Some(settings.artifact_directory.join("output"));
        config.limits.max_active_executions = settings.max_processes;
        config.limits.max_retained_executions = settings.max_requests;
        config.limits.finished_retention = settings
            .retention
            .unread_results
            .max(Duration::from_millis(1));
        config.limits.run_output_retention =
            settings.retention.artifacts.max(Duration::from_millis(1));
        config.limits.max_retained_output_bytes = settings.max_session_output_bytes;
        config.limits.max_output_bytes_per_response =
            settings.max_output_bytes.min(native::MAX_RUN_PREVIEW_BYTES);
        config.limits.max_file_read_bytes = settings.max_file_bytes;
        config.limits.max_file_write_bytes = settings.max_file_bytes;
        config.limits.termination_grace = settings.termination_grace;
        config.limits.output_drain_timeout = settings.output_drain_timeout;
        config.limits.max_file_mutation_receipts = settings.max_requests;

        let native = native::ProcessExecutionCore::new(config)?;
        std::fs::create_dir_all(&runtime_directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&runtime_directory, std::fs::Permissions::from_mode(0o700))?;
        }
        std::fs::write(
            runtime_directory.join("python_runner.py"),
            include_str!("runners/python_runner.py"),
        )?;
        std::fs::write(
            runtime_directory.join("node_runner.cjs"),
            include_str!("runners/node_runner.cjs"),
        )?;
        let core = Self {
            inner: Arc::new(Inner {
                config: settings,
                generation,
                runtime_directory,
                stopping: AtomicBool::new(false),
                runtime: Arc::new(Runtime {
                    native,
                    cancel: CancellationToken::new(),
                    ledger: Mutex::new(Ledger::new()),
                    processes: Mutex::new(HashMap::new()),
                    repls: Mutex::new(HashMap::new()),
                    repl_creation: tokio::sync::Mutex::new(()),
                    artifacts: Mutex::new(Vec::new()),
                }),
            }),
        };
        let weak = Arc::downgrade(&core.inner);
        let interval = core.inner.config.retention.sweep_interval;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                if inner.stopping.load(Ordering::Acquire) {
                    break;
                }
                ProcessExecutionCore { inner }.sweep().await;
            }
        });
        Ok(core)
    }
    pub fn generation(&self) -> Uuid {
        self.inner.generation
    }
    pub fn capabilities(&self) -> Value {
        json!({"generation": self.generation(), "operations": ["execution.exec", "execution.interact", "execution.close", "filesystem.read", "filesystem.write", "filesystem.patch", "repl.execute", "repl.collect", "repl.interrupt", "repl.reset", "repl.close"], "repl_runtimes": ["python", "node"], "max_file_bytes": self.inner.config.max_file_bytes, "max_output_bytes": self.inner.config.max_output_bytes})
    }
    /// Records acceptance before dispatch. Caller cancellation drops only its
    /// wait: the detached operation continues and records the exact result.
    pub fn execute(
        &self,
        request: Request,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + '_>> {
        Box::pin(self.execute_inner(request, CancellationToken::new()))
    }
    async fn execute_inner(&self, request: Request, cancel: CancellationToken) -> Result<Value> {
        validate_id(&request.request_id)?;
        let runtime = self.inner.runtime.clone();
        let bytes =
            serde_json::to_vec(&request.operation).map_err(|e| Error::invalid(e.to_string()))?;
        if bytes.len() > self.inner.config.max_request_bytes {
            return Err(Error::new(ErrorCode::ResourceLimit, "request too large"));
        }
        let fingerprint = Sha256::digest(&bytes).to_vec();
        let reserve = self.inner.config.max_result_bytes;
        let (receipt, new) = {
            let mut ledger = runtime.ledger.lock().unwrap();
            if let Some(receipt) = ledger.entries.get(&request.request_id) {
                if receipt.fingerprint != fingerprint {
                    return Err(Error::new(
                        ErrorCode::IdempotencyConflict,
                        "request_id already identifies different input",
                    ));
                }
                (receipt.clone(), false)
            } else {
                ensure_open(&runtime)?;
                if ledger.entries.len() >= self.inner.config.max_requests
                    || ledger.pending >= self.inner.config.max_pending_requests
                    || ledger.bytes.saturating_add(reserve) > self.inner.config.max_receipt_bytes
                {
                    return Err(Error::new(
                        ErrorCode::ResourceLimit,
                        "global request receipt capacity reached",
                    ));
                }
                let (result, _) = tokio::sync::watch::channel(None);
                let receipt = Arc::new(Receipt {
                    fingerprint,
                    cancel,
                    result,
                    delivered: Mutex::new(None),
                });
                ledger
                    .entries
                    .insert(request.request_id.clone(), receipt.clone());
                ledger.bytes += reserve;
                ledger.pending += 1;
                (receipt, true)
            }
        };
        if new {
            let core = self.clone();
            let receipt = receipt.clone();
            tokio::spawn(async move {
                let mutation_id = request.request_id.clone();
                let task_core = core.clone();
                let task_runtime = runtime.clone();
                let cancel = receipt.cancel.clone();
                let result = tokio::spawn(async move {
                    task_core
                        .dispatch(task_runtime, &request.request_id, request.operation, cancel)
                        .await
                })
                .await
                .unwrap_or_else(|e| {
                    Err(Error::new(
                        ErrorCode::Unavailable,
                        format!("operation task failed; outcome may be partial: {e}"),
                    ))
                });
                runtime.native.forget_mutation(&mutation_id).await;
                let result = if receipts::size(&result) > reserve {
                    Err(Error::new(
                        ErrorCode::ResourceLimit,
                        "result exceeded reserved receipt size; effects may have occurred",
                    ))
                } else {
                    result
                };
                let mut ledger = runtime.ledger.lock().unwrap();
                ledger.bytes = ledger.bytes.saturating_sub(reserve) + receipts::size(&result);
                ledger.pending -= 1;
                receipt.result.send_replace(Some(result));
            });
        }
        receipts::wait(&receipt).await
    }
    pub(crate) fn execute_with_cancel(
        &self,
        request: Request,
        cancel: CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + '_>> {
        Box::pin(self.execute_inner(request, cancel))
    }
    /// Transport hook: mark a durably delivered result eligible for retention cleanup.
    /// This does not cancel yielded work or remove the request's replay identity.
    pub fn mark_delivered(&self, request_id: &str) -> Result<()> {
        let runtime = &self.inner.runtime;
        let ledger = runtime.ledger.lock().unwrap();
        let receipt = ledger
            .entries
            .get(request_id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "request not found"))?;
        if receipt.result.borrow().is_none() {
            return Err(Error::new(ErrorCode::InvalidState, "request still running"));
        }
        receipt
            .delivered
            .lock()
            .unwrap()
            .get_or_insert_with(Instant::now);
        Ok(())
    }
    pub fn cancel(&self, request_id: &str) -> Result<()> {
        let runtime = &self.inner.runtime;
        let ledger = runtime.ledger.lock().unwrap();
        let receipt = ledger
            .entries
            .get(request_id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "request not found"))?;
        receipt.cancel.cancel();
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.inner.stopping.store(true, Ordering::Release);
        let runtime = &self.inner.runtime;
        // Share the admission lock so no new work can enter after cancellation.
        {
            let _ledger = runtime.ledger.lock().unwrap();
            runtime.cancel.cancel();
        }
        let repls: Vec<_> = runtime.repls.lock().unwrap().values().cloned().collect();
        for repl in repls {
            repl.close().await;
        }
        runtime.native.shutdown().await?;
        while runtime.ledger.lock().unwrap().pending != 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        runtime.processes.lock().unwrap().clear();
        runtime.repls.lock().unwrap().clear();
        let _ = std::fs::remove_dir_all(&self.inner.runtime_directory);
        Ok(())
    }
    pub async fn sweep(&self) {
        let runtime = &self.inner.runtime;
        runtime
            .ledger
            .lock()
            .unwrap()
            .sweep(self.inner.config.retention.delivered_receipts);
        runtime
            .processes
            .lock()
            .unwrap()
            .retain(|_, session| !session.expired(self.inner.config.retention.unread_results));
        // Closed interpreters retain events for the same bounded result window.
        runtime.repls.lock().unwrap().retain(|_, repl| {
            repl.sweep(self.inner.config.retention.unread_results);
            !repl.expired(self.inner.config.retention.unread_results)
        });
        runtime.artifacts.lock().unwrap().retain(|(path, at)| {
            if at.elapsed() < self.inner.config.retention.artifacts {
                return true;
            }
            let _ = std::fs::remove_file(path);
            false
        });
    }
    async fn dispatch(
        &self,
        runtime: Arc<Runtime>,
        id: &str,
        operation: Operation,
        cancel: CancellationToken,
    ) -> Result<Value> {
        if runtime.cancel.is_cancelled() || cancel.is_cancelled() {
            return Err(Error::new(
                ErrorCode::Cancelled,
                "operation cancelled before execution",
            ));
        }
        match operation {
            Operation::Exec(args) => self.exec(runtime, id, args, cancel).await,
            Operation::Interact(args) => self.interact(runtime, id, args, cancel).await,
            Operation::CloseExec { session_id } => self.close_exec(runtime, session_id).await,
            Operation::Read(args) => self.read_file(runtime, args).await,
            Operation::Write(args) => self.write_file(runtime, id, args).await,
            Operation::Patch { cwd, patch } => {
                let receipt = runtime
                    .native
                    .apply_patch(native::ApplyPatchRequest {
                        mutation_id: id.into(),
                        cwd: Some(validate_cwd(cwd)?),
                        patch,
                    })
                    .await?;
                value(receipt)
            }
            Operation::ReplExecute(args) => self.repl_execute(runtime, id, args, cancel).await,
            Operation::ReplCollect(args) => self.repl_collect(runtime, args, cancel).await,
            Operation::ReplInterrupt { session } => self.repl_interrupt(runtime, session).await,
            Operation::ReplReset { session } => self.repl_reset(runtime, session).await,
            Operation::ReplClose { session } => {
                let repl = self.repl(&runtime, &session)?;
                repl.close().await;
                Ok(json!({"state":"closed"}))
            }
        }
    }
}
pub(crate) fn value<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| Error::new(ErrorCode::Io, e.to_string()))
}
pub(crate) fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 256 || id.contains('\0') {
        Err(Error::invalid(
            "identity must contain 1..256 bytes and no NUL",
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn ensure_open(runtime: &Runtime) -> Result<()> {
    if runtime.cancel.is_cancelled() {
        Err(Error::new(
            ErrorCode::Unavailable,
            "runtime is shutting down",
        ))
    } else {
        Ok(())
    }
}
pub(crate) fn validate_cwd(cwd: PathBuf) -> Result<PathBuf> {
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(Error::invalid("cwd must be an existing absolute directory"));
    }
    Ok(cwd)
}
