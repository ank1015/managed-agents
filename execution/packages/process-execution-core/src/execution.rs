use crate::{
    Error, ErrorCode, ProcessExecutionCore, Result,
    api::*,
    buffer::Buffer,
    core::{Runtime, validate_cwd, value},
    native,
};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::Write,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(crate) struct ExecSession {
    pub handle: OnceLock<native::ExecutionHandle>,
    pub tty: bool,
    buffer: Mutex<Buffer>,
    result: Mutex<Option<native::Execution>>,
    finished_at: Mutex<Option<Instant>>,
    changed: Notify,
    lock: AsyncMutex<()>,
    closed: AtomicBool,
    spool: Mutex<Option<Spool>>,
}
struct Spool {
    file: Option<File>,
    artifact: Artifact,
    limit: u64,
}
impl ExecSession {
    pub fn expired(&self, ttl: Duration) -> bool {
        self.finished_at
            .lock()
            .unwrap()
            .is_some_and(|at| at.elapsed() >= ttl)
    }
    fn capture(&self, bytes: &[u8]) {
        self.buffer.lock().unwrap().push(bytes);
        if let Some(spool) = self.spool.lock().unwrap().as_mut() {
            let allowed = (spool.limit.saturating_sub(spool.artifact.size_bytes))
                .min(bytes.len() as u64) as usize;
            if let Some(file) = spool.file.as_mut() {
                if file.write_all(&bytes[..allowed]).is_ok() {
                    spool.artifact.size_bytes += allowed as u64;
                } else {
                    spool.artifact.complete = false;
                    spool.file = None;
                }
            }
            if allowed < bytes.len() {
                spool.artifact.complete = false;
                spool.file = None;
            }
        }
        self.changed.notify_waiters();
    }
    fn finish(&self, execution: native::Execution, retention: Duration) {
        if let Some(spool) = self.spool.lock().unwrap().as_mut() {
            if let Some(mut file) = spool.file.take()
                && file.flush().is_err()
            {
                spool.artifact.complete = false;
            }
            spool.artifact.complete &= !execution.output_incomplete;
            spool.artifact.expires_at_ms =
                Some(epoch_ms().saturating_add(retention.as_millis().min(u64::MAX as u128) as u64));
        }
        *self.finished_at.lock().unwrap() = Some(Instant::now());
        *self.result.lock().unwrap() = Some(execution);
        self.changed.notify_waiters();
    }
}
impl ProcessExecutionCore {
    pub(crate) fn output_options(&self, output: &OutputOptions) -> Result<usize> {
        let max = output.max_bytes.unwrap_or(40000);
        if max == 0 || max > self.inner.config.max_output_bytes || output.max_lines == Some(0) {
            return Err(Error::invalid("invalid output budget"));
        }
        Ok(max)
    }
    pub(crate) fn validate_completion(&self, completion: Completion) -> Result<()> {
        match completion {
            Completion::Yield { wait_ms }
                if wait_ms > self.inner.config.max_wait.as_millis() as u64 =>
            {
                Err(Error::invalid("wait exceeds configured maximum"))
            }
            Completion::Finished {
                timeout_ms: Some(0),
            } => Err(Error::invalid("timeout must be positive")),
            _ => Ok(()),
        }
    }
    pub(crate) async fn exec(
        &self,
        runtime: Arc<Runtime>,
        id: &str,
        args: ExecRequest,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.output_options(&args.output)?;
        self.validate_completion(args.completion)?;
        if args.tty && matches!(args.completion, Completion::Finished { .. }) {
            return Err(Error::invalid("completion-only execution requires pipes"));
        }
        let cwd = validate_cwd(args.cwd)?;
        let mut spool = None;
        if args.output.retain_full_output {
            let id = Uuid::new_v4();
            let path = self.inner.runtime_directory.join(format!("{id}.log"));
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(&path)?;
            spool = Some(Spool {
                file: Some(file),
                artifact: Artifact {
                    id,
                    path,
                    size_bytes: 0,
                    complete: true,
                    expires_at_ms: None,
                },
                limit: self.inner.config.max_artifact_bytes,
            });
        }
        let session = Arc::new(ExecSession {
            handle: OnceLock::new(),
            tty: args.tty,
            buffer: Mutex::new(Buffer::new(self.inner.config.max_session_output_bytes)),
            result: Mutex::new(None),
            finished_at: Mutex::new(None),
            changed: Notify::new(),
            lock: AsyncMutex::new(()),
            closed: AtomicBool::new(false),
            spool: Mutex::new(spool),
        });
        let session_id = {
            let mut processes = runtime.processes.lock().unwrap();
            let active = processes
                .values()
                .filter(|s| s.finished_at.lock().unwrap().is_none())
                .count();
            if active >= self.inner.config.max_processes {
                if let Some(spool) = session.spool.lock().unwrap().take() {
                    let _ = std::fs::remove_file(spool.artifact.path);
                }
                return Err(Error::new(
                    ErrorCode::ResourceLimit,
                    "process capacity reached",
                ));
            }
            let id = Uuid::new_v4();
            processes.insert(id, session.clone());
            id
        };
        let initial_guard = session.lock.lock().await;
        let capture = session.clone();
        let env = args.env;
        let start = native::StartRequest {
            start_id: id.into(),
            command: args.command,
            cwd: Some(cwd),
            env,
            shell_snapshot: None,
            io: if args.tty {
                native::IoMode::Pty { rows: 24, cols: 80 }
            } else {
                native::IoMode::Pipes { stdin: false }
            },
            wait_ms: 0,
            max_output_bytes: Some(1),
            labels: Default::default(),
        };
        let started = match runtime
            .native
            .start_with_capture(start, Some(Arc::new(move |bytes| capture.capture(bytes))))
            .await
        {
            Ok(started) => started,
            Err(error) => {
                runtime.processes.lock().unwrap().remove(&session_id);
                if let Some(spool) = session.spool.lock().unwrap().take() {
                    let _ = std::fs::remove_file(spool.artifact.path);
                }
                return Err(error);
            }
        };
        let handle = started.execution.handle;
        let _ = session.handle.set(handle);
        let monitor = session.clone();
        let owner = runtime.clone();
        let retention = self.inner.config.retention.artifacts;
        let lifetime_cancel = cancel.clone();
        tokio::spawn(async move {
            let mut snapshot = started.execution;
            if snapshot.state != native::ExecutionState::Finished {
                let finished = tokio::select! {
                    result = owner.native.wait_finished(handle) => result,
                    _ = owner.cancel.cancelled() => {
                        let _ = owner.native.terminate_execution(handle, None).await;
                        owner.native.wait_finished(handle).await
                    },
                    _ = lifetime_cancel.cancelled() => {
                        let _ = owner.native.terminate_execution(handle, None).await;
                        owner.native.wait_finished(handle).await
                    }
                };
                match finished {
                    Ok(finished) => snapshot = finished,
                    Err(error) => {
                        snapshot.state = native::ExecutionState::Finished;
                        snapshot.result = Some(native::ExecutionResult::Lost {
                            message: error.message,
                        });
                    }
                }
            }
            monitor.finish(snapshot, retention);
            if let Some(spool) = monitor.spool.lock().unwrap().as_ref() {
                owner
                    .artifacts
                    .lock()
                    .unwrap()
                    .push((spool.artifact.path.clone(), Instant::now()));
            }
        });
        let result = self
            .collect_exec(
                &runtime,
                &session,
                session_id,
                args.completion,
                &args.output,
                cancel,
            )
            .await;
        drop(initial_guard);
        result
    }
    pub(crate) async fn interact(
        &self,
        runtime: Arc<Runtime>,
        id: &str,
        args: InteractRequest,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.output_options(&args.output)?;
        let session = runtime
            .processes
            .lock()
            .unwrap()
            .get(&args.session_id)
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::SessionClosed,
                    "unknown or expired execution session",
                )
            })?;
        let guard = tokio::select! { guard = session.lock.lock() => guard, _ = cancel.cancelled() => return Err(Error::new(ErrorCode::Cancelled,"interaction cancelled")), _ = runtime.cancel.cancelled() => return Err(Error::new(ErrorCode::Unavailable,"runtime is shutting down")) };
        if session.closed.load(Ordering::Acquire) {
            return Err(Error::new(
                ErrorCode::SessionClosed,
                "execution session is closed",
            ));
        }
        let handle = *session
            .handle
            .get()
            .ok_or_else(|| Error::new(ErrorCode::InvalidState, "process is starting"))?;
        let empty = matches!(&args.input, Input::None)
            || matches!(&args.input, Input::Text(s) if s.is_empty());
        let wait = args.wait_ms.unwrap_or(if empty { 5000 } else { 250 });
        let wait = wait
            .clamp(
                if empty { 5000 } else { 250 },
                if empty { 300000 } else { 30000 },
            )
            .min(self.inner.config.max_wait.as_millis() as u64);
        if session.result.lock().unwrap().is_none() {
            match args.input {
                Input::None => (),
                Input::Interrupt => {
                    runtime.native.interrupt_execution(handle, id).await?;
                }
                Input::Text(ref text) if text.is_empty() => (),
                Input::Text(ref text) if !session.tty && text == "\u{3}" => {
                    runtime.native.interrupt_execution(handle, id).await?;
                }
                Input::Text(_) if !session.tty => {
                    return Err(Error::new(
                        ErrorCode::StdinClosed,
                        "stdin is closed; use tty=true for interactive input",
                    ));
                }
                Input::Text(text) => {
                    runtime
                        .native
                        .write_input(handle, id, text.into_bytes())
                        .await?;
                }
            }
        }
        let result = self
            .collect_exec(
                &runtime,
                &session,
                args.session_id,
                Completion::Yield { wait_ms: wait },
                &args.output,
                cancel,
            )
            .await;
        drop(guard);
        result
    }
    async fn collect_exec(
        &self,
        runtime: &Runtime,
        session: &ExecSession,
        id: Uuid,
        completion: Completion,
        output: &OutputOptions,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let started = Instant::now();
        let timeout = match completion {
            Completion::Yield { wait_ms } => {
                Some(Duration::from_millis(wait_ms.clamp(250, 300000)))
            }
            Completion::Finished { timeout_ms } => timeout_ms.map(Duration::from_millis),
        };
        let deadline =
            timeout.and_then(|duration| tokio::time::Instant::now().checked_add(duration));
        let mut timed_out = false;
        loop {
            let changed = session.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if session.result.lock().unwrap().is_some() {
                break;
            }
            tokio::select! {
                _ = &mut changed => (),
                _ = async { match deadline { Some(at) => tokio::time::sleep_until(at).await, None => std::future::pending().await } } => {
                    if matches!(completion, Completion::Finished { .. }) { timed_out = true; self.terminate_and_wait(runtime, session).await?; }
                    break;
                },
                _ = cancel.cancelled() => { self.terminate_and_wait(runtime, session).await?; break; },
                _ = runtime.cancel.cancelled() => { self.terminate_and_wait(runtime, session).await?; break; },
            }
        }
        let snapshot = session.result.lock().unwrap().clone();
        let buffer = std::mem::replace(
            &mut *session.buffer.lock().unwrap(),
            Buffer::new(self.inner.config.max_session_output_bytes),
        );
        let (text, truncated) = buffer.render(
            output.strategy,
            self.output_options(output)?,
            output.max_lines,
        );
        let (exit_code, signal, reason) = match snapshot.as_ref().and_then(|s| s.result.as_ref()) {
            Some(native::ExecutionResult::Exited { exit_code, signal }) => (
                exit_code.map(i64::from),
                signal.clone(),
                Some("exited".into()),
            ),
            Some(native::ExecutionResult::Terminated { exit_code, signal }) => (
                exit_code.map(i64::from),
                signal.clone(),
                Some(if timed_out { "timed_out" } else { "terminated" }.into()),
            ),
            Some(native::ExecutionResult::TimedOut { exit_code, signal }) => (
                exit_code.map(i64::from),
                signal.clone(),
                Some("timed_out".into()),
            ),
            Some(native::ExecutionResult::StartFailed { message }) => {
                (None, None, Some(format!("start_failed: {message}")))
            }
            Some(native::ExecutionResult::Lost { message }) => {
                (None, None, Some(format!("lost: {message}")))
            }
            None => (None, None, None),
        };
        if snapshot.is_some() {
            session.closed.store(true, Ordering::Release);
        }
        value(ExecResult {
            session_id: snapshot.is_none().then_some(id),
            state: if snapshot.is_some() {
                "finished"
            } else {
                "running"
            }
            .into(),
            exit_code,
            signal,
            reason,
            output: text,
            original_bytes: buffer.total,
            output_truncated: truncated,
            output_incomplete: snapshot.as_ref().is_some_and(|s| s.output_incomplete),
            wall_time_seconds: started.elapsed().as_secs_f64(),
            artifact: session.spool.lock().unwrap().as_ref().map(|s| {
                let mut artifact = s.artifact.clone();
                artifact.complete &= snapshot.is_some();
                artifact
            }),
        })
    }
    async fn terminate_and_wait(&self, runtime: &Runtime, session: &ExecSession) -> Result<()> {
        let needs_termination = session.result.lock().unwrap().is_none();
        if needs_termination && let Some(handle) = session.handle.get() {
            runtime.native.terminate_execution(*handle, None).await?;
        }
        loop {
            let changed = session.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if session.result.lock().unwrap().is_some() {
                return Ok(());
            }
            changed.await;
        }
    }
    pub(crate) async fn close_exec(&self, runtime: Arc<Runtime>, id: Uuid) -> Result<Value> {
        let session = runtime
            .processes
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::SessionClosed, "execution session is closed"))?;
        self.terminate_and_wait(&runtime, &session).await?;
        session.closed.store(true, Ordering::Release);
        Ok(json!({"state":"closed"}))
    }
}
pub(crate) fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
