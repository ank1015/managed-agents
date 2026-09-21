mod state;
mod transport;
use crate::{
    Error, ErrorCode, ProcessExecutionCore, Result,
    api::*,
    core::{Runtime, validate_id, value},
};
use serde_json::{Value, json};
pub(crate) use state::{CellExecution, ReplSession};
use std::{
    collections::HashSet,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

impl ProcessExecutionCore {
    pub(crate) fn repl(&self, runtime: &Runtime, handle: &Uuid) -> Result<Arc<ReplSession>> {
        runtime
            .repls
            .lock()
            .unwrap()
            .get(handle)
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::SessionLost,
                    "REPL not found; create a new session explicitly",
                )
            })
    }
    pub(crate) async fn repl_execute(
        &self,
        runtime: Arc<Runtime>,
        request_id: &str,
        args: ReplExecuteRequest,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.validate_completion(args.completion)?;
        if args.cells.is_empty() || args.cells.len() > self.inner.config.max_cells {
            return Err(Error::invalid("invalid cell count"));
        }
        let mut ids = HashSet::new();
        for cell in &args.cells {
            validate_id(&cell.id)?;
            if !ids.insert(&cell.id) {
                return Err(Error::invalid("duplicate cell ID"));
            }
        }
        let repl = match args.target {
            ReplTarget::Create {
                runtime: language,
                cwd,
                env,
            } => {
                self.create_repl(runtime.clone(), language, cwd, env)
                    .await?
            }
            ReplTarget::Existing { session } => self.repl(&runtime, &session)?,
        };
        if repl.exited.load(Ordering::Acquire) {
            return Err(Error::new(
                ErrorCode::SessionLost,
                "interpreter is closed or lost; create/reset explicitly",
            ));
        }
        let execution = Arc::new(CellExecution::new(&args.cells));
        {
            let mut executions = repl.executions.lock().unwrap();
            if executions.len() >= self.inner.config.max_requests {
                return Err(Error::new(
                    ErrorCode::ResourceLimit,
                    "REPL execution receipt capacity reached",
                ));
            }
            executions.insert(execution.id, execution.clone());
        }
        let core = self.clone();
        let owner = runtime.clone();
        let runner = repl.clone();
        let work = execution.clone();
        let request_id = request_id.to_owned();
        tokio::spawn(async move {
            // FIFO session queue. Controls never acquire this lock.
            let guard = tokio::select! {
                guard = runner.queue.lock() => guard,
                _ = owner.cancel.cancelled() => { work.finish("cancelled","preserved"); return; },
                _ = cancel.cancelled() => { work.finish("cancelled","preserved"); return; },
            };
            if cancel.is_cancelled() || owner.cancel.is_cancelled() {
                work.finish("cancelled", "preserved");
                return;
            }
            if runner.exited.load(Ordering::Acquire) {
                work.finish("lost", "lost");
                return;
            }
            *work.origin_request.lock().unwrap() = Some(request_id);
            work.set_running();
            let message = json!({"type":"execute","execution_id":work.id,"cells":args.cells,"stop_on_error":args.stop_on_error});
            if runner.send(&message).await.is_err() {
                runner.kill();
                work.finish("lost", "lost");
                return;
            }
            let deadline = match args.completion {
                Completion::Finished {
                    timeout_ms: Some(ms),
                } => tokio::time::Instant::now().checked_add(Duration::from_millis(ms)),
                _ => None,
            };
            loop {
                let changed = work.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if work.is_done() {
                    break;
                }
                tokio::select! {
                    _ = &mut changed => (),
                    _ = owner.cancel.cancelled() => { runner.close().await; work.finish("cancelled","lost"); break; },
                    _ = cancel.cancelled() => { core.interrupt_repl(&runner).await; if !work.is_done() {work.finish("cancelled","possibly_modified");} break; },
                    _ = async {match deadline {Some(at)=>tokio::time::sleep_until(at).await,None=>std::future::pending().await}} => {
                        core.interrupt_repl(&runner).await;
                        if !work.is_done() {work.finish("cancelled","possibly_modified");}
                        break;
                    },
                }
            }
            drop(guard);
        });
        let wait = match args.completion {
            Completion::Yield { wait_ms } => Some(Duration::from_millis(wait_ms)),
            Completion::Finished { .. } => None,
        };
        self.collect_repl(&repl, &execution, wait, CancellationToken::new(), &runtime)
            .await
    }
    pub(crate) async fn repl_collect(
        &self,
        runtime: Arc<Runtime>,
        args: ReplCollectRequest,
        cancel: CancellationToken,
    ) -> Result<Value> {
        if args.wait_ms > self.inner.config.max_wait.as_millis() as u64 {
            return Err(Error::invalid("wait exceeds configured maximum"));
        }
        let repl = self.repl(&runtime, &args.session)?;
        let work = repl
            .executions
            .lock()
            .unwrap()
            .get(&args.execution_id)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "cell execution not found"))?;
        self.collect_repl(
            &repl,
            &work,
            Some(Duration::from_millis(args.wait_ms)),
            cancel,
            &runtime,
        )
        .await
    }
    async fn collect_repl(
        &self,
        repl: &ReplSession,
        work: &CellExecution,
        wait: Option<Duration>,
        cancel: CancellationToken,
        runtime: &Runtime,
    ) -> Result<Value> {
        let _guard = work.collect.lock().await;
        let deadline = wait.and_then(|d| tokio::time::Instant::now().checked_add(d));
        loop {
            let changed = work.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if work.is_done() {
                break;
            }
            tokio::select! {
                _ = &mut changed => (),
                _ = async {match deadline {Some(at)=>tokio::time::sleep_until(at).await,None=>std::future::pending().await}} => break,
                _ = cancel.cancelled() => return Err(Error::new(ErrorCode::Cancelled,"collection cancelled; cell was not re-executed")),
                _ = runtime.cancel.cancelled() => { repl.close().await; break; },
            }
        }
        let mut state = work.state.lock().unwrap();
        if state.expired {
            return Err(Error::new(ErrorCode::ResultExpired, "cell result expired"));
        }
        let events = std::mem::take(&mut state.events);
        repl.buffered.fetch_sub(state.bytes, Ordering::AcqRel);
        state.bytes = 0;
        let background = std::mem::take(&mut *repl.background.lock().unwrap());
        let background_bytes = background
            .iter()
            .map(|e| serde_json::to_vec(e).map_or(0, |b| b.len()))
            .sum::<usize>();
        repl.buffered.fetch_sub(background_bytes, Ordering::AcqRel);
        value(ReplResult {
            session: repl.handle,
            execution_id: work.id,
            state: state.status.clone(),
            state_integrity: state.integrity.clone(),
            events: events.into_iter().chain(background).collect(),
            events_truncated: state.truncated
                || repl.background_truncated.swap(false, Ordering::AcqRel),
            cells: state.cells.clone(),
        })
    }
    pub(crate) async fn interrupt_repl(&self, repl: &ReplSession) {
        if repl.exited.load(Ordering::Acquire) {
            return;
        }
        let active: Vec<_> = repl
            .executions
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.state.lock().unwrap().status == "running")
            .cloned()
            .collect();
        if active.is_empty() {
            return;
        }
        for work in &active {
            work.helpers_cancel.cancel();
        }
        let _ = repl.control.interrupt();
        let until = Instant::now() + self.inner.config.interrupt_grace;
        while active.iter().any(|e| !e.is_done()) {
            if Instant::now() >= until {
                repl.close().await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        for work in active {
            work.state.lock().unwrap().integrity = if repl.exited.load(Ordering::Acquire) {
                "lost"
            } else {
                "possibly_modified"
            }
            .into();
        }
    }
    pub(crate) async fn repl_interrupt(
        &self,
        runtime: Arc<Runtime>,
        handle: Uuid,
    ) -> Result<Value> {
        let repl = self.repl(&runtime, &handle)?;
        self.interrupt_repl(&repl).await;
        Ok(
            json!({"session":handle,"state_integrity":if repl.exited.load(Ordering::Acquire){"lost"}else{"possibly_modified"}}),
        )
    }
    pub(crate) async fn repl_reset(&self, runtime: Arc<Runtime>, handle: Uuid) -> Result<Value> {
        let old = self.repl(&runtime, &handle)?;
        old.close().await;
        let new = self
            .create_repl(runtime, old.language, old.cwd.clone(), old.env.clone())
            .await?;
        Ok(json!({"session":new.handle,"previous_session":handle,"state":"ready"}))
    }
}
