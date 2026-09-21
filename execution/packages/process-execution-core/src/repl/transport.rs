use super::*;
use crate::{
    core::{ensure_open, validate_cwd},
    native::{IoMode, OutputStream, backend},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    net::TcpListener,
    sync::{Mutex as AsyncMutex, Notify},
};

impl ProcessExecutionCore {
    pub(crate) async fn create_repl(
        &self,
        runtime: Arc<Runtime>,
        language: Language,
        cwd: std::path::PathBuf,
        environment: std::collections::BTreeMap<String, String>,
    ) -> Result<Arc<ReplSession>> {
        let cwd = validate_cwd(cwd)?;
        let _creation = runtime.repl_creation.lock().await;
        ensure_open(&runtime)?;
        if runtime
            .repls
            .lock()
            .unwrap()
            .values()
            .filter(|r| !r.exited.load(Ordering::Acquire))
            .count()
            >= self.inner.config.max_repls
        {
            return Err(Error::new(
                ErrorCode::ResourceLimit,
                "REPL capacity reached",
            ));
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let token = Uuid::new_v4().to_string();
        let mut env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        env.extend(environment.clone());
        env.insert(
            "EXECUTION_REPL_PORT".into(),
            listener.local_addr()?.port().to_string(),
        );
        env.insert("EXECUTION_REPL_TOKEN".into(), token.clone());
        // Isolate interpreter history/runtime files from the user's home.
        env.insert(
            "IPYTHONDIR".into(),
            self.inner.runtime_directory.to_string_lossy().into_owned(),
        );
        env.insert("PYTHONUNBUFFERED".into(), "1".into());
        let (executable, script) = match language {
            Language::Python => (self.inner.config.python.clone(), "python_runner.py"),
            Language::Node => (self.inner.config.node.clone(), "node_runner.cjs"),
        };
        let backend::Process {
            control,
            readers,
            writer: _,
            mut wait,
        } = backend::spawn(backend::Launch {
            executable,
            args: vec![self.inner.runtime_directory.join(script).into_os_string()],
            cwd: cwd.clone(),
            env,
            io: IoMode::Pipes { stdin: false },
        })
        .map_err(|e| Error::new(ErrorCode::InterpreterUnavailable, e.message))?;
        let startup_log = Arc::new(Mutex::new(String::new()));
        let destination: Arc<Mutex<Option<std::sync::Weak<ReplSession>>>> =
            Arc::new(Mutex::new(None));
        let mut pumps = Vec::new();
        for (stream, mut reader) in readers {
            let destination = destination.clone();
            let log = startup_log.clone();
            pumps.push(tokio::spawn(async move{
                let mut bytes=[0u8;4096];
                while let Ok(count)=reader.read(&mut bytes).await {
                    if count==0{break;}
                    let text=String::from_utf8_lossy(&bytes[..count]).to_string();
                    let target=destination.lock().unwrap().as_ref().and_then(|w|w.upgrade());
                    if let Some(repl)=target {repl.event(None,json!({"kind":if stream==OutputStream::Stderr{"stderr"}else{"stdout"},"text":text,"execution_id":null,"cell_id":null}));}
                    else {let mut log=log.lock().unwrap();if log.len()<16384{log.push_str(&text);}}
                }
            }));
        }
        let timeout = self.inner.config.repl_startup_timeout;
        let handshake = async {
            let (stream, _) = listener.accept().await?;
            let (read, write) = stream.into_split();
            let mut read = BufReader::new(read);
            let frame = read_frame(&mut read, 4096).await?;
            if frame["type"] != "hello" || frame["token"] != token {
                return Err(Error::invalid("invalid interpreter handshake"));
            }
            Ok((read, write))
        };
        let connected = tokio::select! {
            result=tokio::time::timeout(timeout,handshake)=>result.map_err(|_|Error::new(ErrorCode::InterpreterUnavailable,"interpreter handshake timed out")).and_then(|x|x),
            _=&mut wait=>Err(Error::new(ErrorCode::InterpreterUnavailable,format!("interpreter exited during startup: {}",startup_log.lock().unwrap()))),
            _=runtime.cancel.cancelled()=>Err(Error::new(ErrorCode::Unavailable,"runtime is shutting down during interpreter startup")),
        };
        let (mut read, writer) = match connected {
            Ok(value) => value,
            Err(error) => {
                let _ = control.kill();
                for pump in pumps {
                    pump.abort();
                }
                return Err(error);
            }
        };
        let repl = Arc::new(ReplSession {
            handle: Uuid::new_v4(),
            cwd,
            env: environment,
            exited_at: Mutex::new(None),
            language,
            control: control.clone(),
            writer: AsyncMutex::new(writer),
            queue: AsyncMutex::new(()),
            exited: AtomicBool::new(false),
            exit_notify: Notify::new(),
            executions: Mutex::new(HashMap::new()),
            background: Mutex::new(Vec::new()),
            background_truncated: AtomicBool::new(false),
            buffered: AtomicUsize::new(0),
            buffer_limit: self.inner.config.max_repl_output_bytes,
        });
        *destination.lock().unwrap() = Some(Arc::downgrade(&repl));
        runtime
            .repls
            .lock()
            .unwrap()
            .insert(repl.handle, repl.clone());
        let target = repl.clone();
        let owner = runtime.clone();
        let grace = self.inner.config.output_drain_timeout;
        tokio::spawn(async move {
            tokio::select! {_=&mut wait=>(),_=owner.cancel.cancelled()=>{let _=control.kill();let _=wait.await;}}
            let _ = control.kill();
            for mut pump in pumps {
                if tokio::time::timeout(grace, &mut pump).await.is_err() {
                    pump.abort();
                }
            }
            target.mark_lost();
        });
        let target = repl.clone();
        let weak = Arc::downgrade(&self.inner);
        let frame_limit = self.inner.config.max_request_bytes;
        tokio::spawn(async move {
            loop {
                let message = match read_frame(&mut read, frame_limit).await {
                    Ok(value) => value,
                    Err(_) => break,
                };
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let core = ProcessExecutionCore { inner };
                let execution = message["execution_id"]
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok());
                match message["type"].as_str() {
                    Some("event") => {
                        let mut event = message.clone();
                        if let Some(object) = event.as_object_mut() {
                            object.remove("type");
                        }
                        if let Err(error) = core.validate_display(&mut event).await {
                            event = json!({"kind":"error","message":error.message,"execution_id":execution});
                        }
                        target.event(execution, event);
                    }
                    Some("cell_started" | "cell_done") => {
                        if let Some(work) = execution
                            .and_then(|id| target.executions.lock().unwrap().get(&id).cloned())
                        {
                            let mut state = work.state.lock().unwrap();
                            if let Some(cell) = state
                                .cells
                                .iter_mut()
                                .find(|c| Some(c.id.as_str()) == message["cell_id"].as_str())
                            {
                                cell.status = if message["type"] == "cell_started" {
                                    "running".into()
                                } else {
                                    message["status"].as_str().unwrap_or("failed").into()
                                };
                            }
                        }
                    }
                    Some("execution_done") => {
                        if let Some(work) = execution
                            .and_then(|id| target.executions.lock().unwrap().get(&id).cloned())
                        {
                            work.finish(
                                message["status"].as_str().unwrap_or("failed"),
                                if message["status"] == "succeeded" {
                                    "preserved"
                                } else {
                                    "possibly_modified"
                                },
                            );
                        }
                    }
                    Some("helper") => {
                        let core = core.clone();
                        let repl = target.clone();
                        tokio::spawn(async move {
                            core.handle_helper(repl, message).await;
                        });
                    }
                    _ => break,
                }
            }
            target.kill();
        });
        Ok(repl)
    }
    async fn validate_display(&self, event: &mut Value) -> Result<()> {
        let data = if event["kind"] == "display" {
            event["data_base64"].as_str()
        } else if event["kind"] == "image" {
            event["image"]["data_base64"].as_str()
        } else {
            None
        };
        if let Some(data) = data {
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| Error::invalid("invalid image output"))?;
            let pixels = self.inner.config.max_image_pixels;
            let max = self.inner.config.max_file_bytes;
            let prepared = tokio::task::spawn_blocking(move || {
                crate::files::prepare_image(bytes, None, pixels, max)
            })
            .await
            .map_err(|e| Error::invalid(e.to_string()))??;
            event["kind"] = json!("image");
            event["image"] = prepared;
            if let Some(object) = event.as_object_mut() {
                object.remove("data_base64");
                object.remove("mime_type");
            }
        }
        Ok(())
    }
    async fn handle_helper(&self, repl: Arc<ReplSession>, message: Value) {
        let id = message["id"].as_str().unwrap_or("").to_owned();
        let result = async {
            validate_id(&id)?;
            let execution = message["execution_id"]
                .as_str()
                .and_then(|s| Uuid::parse_str(s).ok())
                .ok_or_else(|| Error::invalid("helper requires a cell execution"))?;
            let work = repl
                .executions
                .lock()
                .unwrap()
                .get(&execution)
                .cloned()
                .ok_or_else(|| Error::invalid("unknown cell execution"))?;
            let parent = work
                .origin_request
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| Error::invalid("cell has not started"))?;
            let mut params = message["params"].clone();
            if matches!(
                message["operation"].as_str(),
                Some(
                    "execution.exec" | "filesystem.read" | "filesystem.write" | "filesystem.patch"
                )
            ) {
                let object = params
                    .as_object_mut()
                    .ok_or_else(|| Error::invalid("helper params must be an object"))?;
                let cwd = object.get("cwd").filter(|v| !v.is_null()).cloned();
                let cwd = match cwd {
                    Some(value) => {
                        let path: std::path::PathBuf = serde_json::from_value(value)
                            .map_err(|e| Error::invalid(e.to_string()))?;
                        if path.is_absolute() {
                            path
                        } else {
                            repl.cwd.join(path)
                        }
                    }
                    None => repl.cwd.clone(),
                };
                object.insert("cwd".into(), json!(cwd));
                if message["operation"] == "execution.exec" {
                    let mut env = repl.env.clone();
                    if let Some(value) = object.get("env") {
                        env.extend(
                            serde_json::from_value::<std::collections::BTreeMap<String, String>>(
                                value.clone(),
                            )
                            .map_err(|e| Error::invalid(e.to_string()))?,
                        );
                    }
                    object.insert("env".into(), json!(env));
                }
            }
            let operation: Operation =
                serde_json::from_value(json!({"operation":message["operation"],"params":params}))
                    .map_err(|e| Error::invalid(e.to_string()))?;
            if !matches!(
                operation,
                Operation::Exec(_)
                    | Operation::Interact(_)
                    | Operation::Read(_)
                    | Operation::Write(_)
                    | Operation::Patch { .. }
            ) {
                return Err(Error::invalid("helper operation is not supported"));
            }
            use sha2::{Digest, Sha256};
            let identity = format!(
                "helper:{:x}",
                Sha256::digest(format!("{parent}:{execution}:{id}"))
            );
            let result = self
                .execute_with_cancel(
                    Request {
                        request_id: identity.clone(),
                        operation,
                    },
                    work.helpers_cancel.child_token(),
                )
                .await;
            // The helper channel is owned by this runtime; request replay remains
            // protected by the parent receipt and the helper tombstone.
            let _ = self.mark_delivered(&identity);
            result
        }
        .await;
        let reply = match result {
            Ok(result) => json!({"type":"helper_result","id":id,"result":result}),
            Err(error) => json!({"type":"helper_result","id":id,"error":error.to_string()}),
        };
        let _ = repl.send(&reply).await;
    }
}
async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Value> {
    let mut bytes = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Err(Error::new(
                ErrorCode::SessionLost,
                "interpreter control connection closed",
            ));
        }
        let count = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |n| n + 1);
        if bytes.len() + count > limit {
            return Err(Error::new(
                ErrorCode::ResourceLimit,
                "interpreter frame exceeds limit",
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            break;
        }
    }
    serde_json::from_slice(&bytes).map_err(|e| Error::invalid(e.to_string()))
}
