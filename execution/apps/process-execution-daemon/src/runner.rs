use crate::{
    Result,
    config::{self, Config},
    http,
    protocol::{self, Action, Incoming},
    store::{self, Admission, Credential, Journal},
};
use futures_util::{SinkExt, StreamExt};
use process_execution_core::ProcessExecutionCore;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{Notify, mpsc},
    time,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{self, Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use tokio_util::task::TaskTracker;
use uuid::Uuid;

pub async fn run(directory: &Path, config: Config) -> Result<()> {
    let _lock = store::Lock::acquire(directory)?;
    let mut credential = Credential::load(directory)?;
    config::gateway(&credential.gateway_url, config.allow_insecure_loopback)?;
    let core = ProcessExecutionCore::new(config.core(directory))?;
    let journal = Arc::new(Journal::open(directory)?);
    journal.recover()?;
    let tasks = TaskTracker::new();
    let (faults, mut errors) = mpsc::unbounded_channel::<String>();
    store::status(
        directory,
        "starting",
        core.generation(),
        "Connecting to the execution gateway",
    )?;
    let _ = std::fs::remove_file(directory.join("stop.json"));
    let engine = Engine {
        core: core.clone(),
        journal: journal.clone(),
        tasks: tasks.clone(),
        config: config.clone(),
        faults,
        ready: Arc::new(Notify::new()),
    };
    let result = tokio::select! {
        result=connections(directory,&mut credential,&engine)=>result,
        _=shutdown(directory,core.generation())=>Ok(()),
        error=errors.recv()=>Err(error.unwrap_or_else(||"execution supervisor stopped".into()).into()),
    };
    store::status(
        directory,
        "stopping",
        core.generation(),
        "Stopping native sessions",
    )?;
    tasks.close();
    let drained = time::timeout(Duration::from_secs(config.shutdown_seconds), async {
        core.shutdown().await?;
        tasks.wait().await;
        Ok::<_, process_execution_core::Error>(())
    })
    .await;
    if !matches!(drained, Ok(Ok(()))) {
        eprintln!(
            "Shutdown deadline reached; unfinished requests will be reported as uncertain at next start."
        );
    }
    let state = if result.is_ok() { "stopped" } else { "error" };
    store::status(
        directory,
        state,
        core.generation(),
        if result.is_ok() {
            "Daemon stopped"
        } else {
            "Connection or execution failed; inspect daemon.log"
        },
    )?;
    result
}
struct Engine {
    core: ProcessExecutionCore,
    journal: Arc<Journal>,
    tasks: TaskTracker,
    config: Config,
    faults: mpsc::UnboundedSender<String>,
    ready: Arc<Notify>,
}
impl Engine {
    fn request(&self, req: Incoming) -> Result<Value> {
        if req.runtime_generation != self.core.generation() {
            return Ok(req.reply(Some((
                "RUNTIME_GENERATION_MISMATCH",
                "Core restarted; this request cannot execute in this generation.",
                false,
                false,
            ))));
        }
        let action = match req.action() {
            Ok(action) => action,
            Err(_) => {
                return Ok(req.reply(Some((
                    "INVALID_REQUEST",
                    "Invalid native operation parameters or request envelope.",
                    false,
                    false,
                ))));
            }
        };
        let admission =
            self.journal
                .admit(&req, matches!(action, Action::Native(_)), &self.config)?;
        match admission {
            Admission::Conflict => {
                return Ok(req.reply(Some((
                    "IDEMPOTENCY_CONFLICT",
                    "Request identity already identifies different input.",
                    false,
                    false,
                ))));
            }
            Admission::Expired => {
                return Ok(req.reply(Some((
                    "RESULT_EXPIRED",
                    "Saved result expired; this identity cannot execute again.",
                    false,
                    true,
                ))));
            }
            Admission::Capacity => {
                return Ok(req.reply(Some((
                    "DAEMON_CAPACITY",
                    "Local request or delivery capacity exhausted; no work started.",
                    true,
                    false,
                ))));
            }
            Admission::Duplicate => {
                self.ready.notify_one();
                return Ok(req.reply(None));
            }
            Admission::New => {}
        }
        let reply = req.reply(None);
        let core = self.core.clone();
        let journal = self.journal.clone();
        let faults = self.faults.clone();
        let ready = self.ready.clone();
        self.tasks.spawn(async move {
            let key=req.key();
            let execution_start=Instant::now();
            let outcome=tokio::spawn(async move{protocol::execute(&core,&req,action).await}).await.unwrap_or_else(|_|protocol::error("EXECUTION_FAILED","Execution task stopped unexpectedly; effects may have occurred.",true));
            if journal.complete_timed(&key,&outcome,Some(execution_start.elapsed().as_secs_f64()*1000.0)).is_err(){let _=faults.send("Could not persist an execution result; stopping to preserve uncertain request receipts.".into());}
            ready.notify_one();
        });
        Ok(reply)
    }
}
async fn connections(directory: &Path, credential: &mut Credential, engine: &Engine) -> Result<()> {
    let mut attempt = 0u32;
    loop {
        engine
            .journal
            .sweep(engine.core.generation(), &engine.config)?;
        let result = connection(directory, credential, engine).await;
        let reason = match result {
            Ok(()) => {
                attempt = 0;
                continue;
            }
            Err(error) => error,
        };
        // Revocation, expiry and replacement need user/backend intervention, not
        // a reconnect race that takes a machine back from a newer daemon.
        if let Some(e) = reason.downcast_ref::<tungstenite::Error>()
            && matches!(e,tungstenite::Error::Http(r) if [401,403,404].contains(&r.status().as_u16()))
        {
            return Err("machine credential was rejected; register/configure a fresh token before connecting".into());
        }
        if reason.to_string() == "connection replaced or revoked" {
            return Err(reason);
        }
        if http::token_claims(&credential.token).is_err() {
            return Err(
                "machine credential expired; obtain a fresh token using register or configure"
                    .into(),
            );
        }
        store::status(
            directory,
            "reconnecting",
            engine.core.generation(),
            "Gateway unavailable; reconnecting automatically",
        )?;
        if attempt == 0 {
            eprintln!("Gateway connection lost. Reconnecting automatically.");
        }
        let wait = backoff(
            engine.config.reconnect_min_ms,
            engine.config.reconnect_max_ms,
            attempt,
        );
        attempt = attempt.saturating_add(1);
        time::sleep(Duration::from_millis(wait)).await;
    }
}
async fn connection(directory: &Path, credential: &mut Credential, engine: &Engine) -> Result<()> {
    let mut url = config::gateway(
        &credential.gateway_url,
        engine.config.allow_insecure_loopback,
    )?;
    url.set_path("/v1/connect");
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| "invalid websocket scheme")?;
    let mut request = url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", credential.token).parse()?,
    );
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(protocol::MAX_FRAME))
        .max_frame_size(Some(protocol::MAX_FRAME));
    let (mut socket, _) = time::timeout(
        Duration::from_secs(15),
        connect_async_with_config(request, Some(ws_config), false),
    )
    .await??;
    let welcome = read_json(&mut socket).await?;
    if welcome["type"] != "welcome"
        || welcome["protocolVersion"] != 1
        || welcome["machineId"] != credential.machine_id.to_string()
    {
        return Err("gateway sent an invalid welcome".into());
    }
    send(&mut socket,json!({"type":"hello","protocolVersion":1,"runtimeGeneration":engine.core.generation(),"daemonVersion":env!("CARGO_PKG_VERSION"),"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"operations":protocol::OPERATIONS})).await?;
    let ready = read_json(&mut socket).await?;
    if ready["type"] != "ready"
        || ready["runtimeGeneration"] != engine.core.generation().to_string()
    {
        return Err("gateway did not confirm daemon readiness".into());
    }
    store::status(
        directory,
        "connected",
        engine.core.generation(),
        "Connected to execution gateway",
    )?;
    eprintln!("Connected. Machine {}", credential.machine_id);
    let ttl = welcome["credentialExpiresAt"]
        .as_i64()
        .ok_or("missing credential expiry")?
        .saturating_sub(store::now())
        .max(0) as u64;
    let refresh_at = Instant::now() + Duration::from_millis((ttl * 4 / 5).max(1000));
    let mut tick = time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    let mut last_seen = Instant::now();
    let mut last_ping = Instant::now();
    let mut last_sweep = Instant::now();
    let heartbeat = Duration::from_secs(engine.config.heartbeat_seconds);
    loop {
        tokio::select! {
            // Consume acknowledgements before another potentially large outgoing frame.
            biased;
            incoming=socket.next()=>{
                match incoming.ok_or("gateway closed connection")?? {
                    Message::Text(raw)=>{
                        last_seen=Instant::now(); if raw=="execution:pong" {continue;}
                        let frame:Value=serde_json::from_str(raw.as_str())?;
                        match frame["type"].as_str() {
                            Some("request")=>{let request:Incoming=serde_json::from_value(frame)?;send(&mut socket,engine.request(request)?).await?;}
                            Some("result_ack")=>{
                                if let Some(meta)=engine.journal.ack(&frame)? && meta.native && meta.runtime_generation==engine.core.generation(){let _=engine.core.mark_delivered(&meta.request_id);}
                            }
                            Some("result_nack")=>{let id=frame["deliveryId"].as_str().ok_or("nack missing identity")?;let retryable=frame["error"]["retryable"].as_bool().ok_or("nack missing retryability")?;let code=frame["error"]["code"].as_str().filter(|v|protocol::identity(v)).ok_or("invalid nack code")?;engine.journal.nack(id,code,retryable)?;if !retryable{eprintln!("Result delivery needs attention ({code}). Run `outbox` for details.");}}
                            Some("protocol_error")=>return Err("gateway rejected the daemon protocol".into()),
                            _=>return Err("unexpected gateway message".into()),
                        }
                    }
                    Message::Ping(data)=>{last_seen=Instant::now();socket.send(Message::Pong(data)).await?;}
                    Message::Pong(_)=>last_seen=Instant::now(),
                    Message::Close(frame)=>{if frame.is_some_and(|f|u16::from(f.code)==4001){return Err("connection replaced or revoked".into());}return Err("gateway closed connection".into());}
                    _=>return Err("expected gateway JSON text".into()),
                }
            }
            _=engine.ready.notified()=>{
                if let Some(delivery)=engine.journal.next()? {
                    engine.journal.attempted(&delivery.key,backoff(engine.config.delivery_retry_ms,30000,delivery.attempts))?;
                    // The acknowledgement window starts after the payload has flushed,
                    // so slow uploads cannot immediately enqueue a duplicate large frame.
                    time::timeout(Duration::from_secs(engine.config.delivery_send_timeout_seconds), socket.send(Message::Text(serde_json_canonicalizer::to_string(&delivery.frame)?.into()))).await??;
                    engine.journal.flushed(&delivery.key,engine.config.delivery_ack_timeout_ms.max(backoff(engine.config.delivery_retry_ms,30000,delivery.attempts)))?;
                }
            }
            _=tick.tick()=>{
                if last_seen.elapsed()>heartbeat*3 {return Err("gateway heartbeat timed out".into());}
                if last_ping.elapsed()>=heartbeat {socket.send(Message::Text("execution:ping".into())).await?;last_ping=Instant::now();}
                if Instant::now()>=refresh_at {
                    http::refresh(directory,credential).await?;
                    socket.close(None).await?;return Ok(());
                }
                if last_sweep.elapsed()>Duration::from_secs(30){engine.journal.sweep(engine.core.generation(),&engine.config)?;last_sweep=Instant::now();}
                if let Some(delivery)=engine.journal.next()? {
                    // Reserve a retry time before writing; a lost send/ack remains retryable.
                    engine.journal.attempted(&delivery.key,backoff(engine.config.delivery_retry_ms,30000,delivery.attempts))?;
                    // The acknowledgement window starts after the payload has flushed,
                    // so slow uploads cannot immediately enqueue a duplicate large frame.
                    time::timeout(Duration::from_secs(engine.config.delivery_send_timeout_seconds), socket.send(Message::Text(serde_json_canonicalizer::to_string(&delivery.frame)?.into()))).await??;
                    engine.journal.flushed(&delivery.key,engine.config.delivery_ack_timeout_ms.max(backoff(engine.config.delivery_retry_ms,30000,delivery.attempts)))?;
                }
            }
        }
    }
}
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn send(socket: &mut Socket, value: Value) -> Result<()> {
    time::timeout(
        Duration::from_secs(10),
        socket.send(Message::Text(
            serde_json_canonicalizer::to_string(&value)?.into(),
        )),
    )
    .await??;
    Ok(())
}
async fn read_json(socket: &mut Socket) -> Result<Value> {
    let msg = time::timeout(Duration::from_secs(10), socket.next())
        .await?
        .ok_or("gateway closed during handshake")??;
    match msg {
        Message::Text(raw) => Ok(serde_json::from_str(raw.as_str())?),
        Message::Close(Some(frame)) if u16::from(frame.code) == 4001 => {
            Err("connection replaced or revoked".into())
        }
        _ => Err("expected gateway handshake JSON".into()),
    }
}
fn backoff(min: u64, max: u64, attempt: u32) -> u64 {
    let ceiling = min.saturating_mul(1u64 << attempt.min(20)).min(max);
    let jitter = u64::from_le_bytes(Uuid::new_v4().as_bytes()[..8].try_into().unwrap());
    ceiling / 2 + jitter % (ceiling / 2 + 1)
}
async fn shutdown(directory: &Path, generation: Uuid) {
    let stop_file = async {
        loop {
            if let Ok(bytes) = std::fs::read(directory.join("stop.json"))
                && serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .is_some_and(|v| v["generation"] == generation.to_string())
            {
                return;
            }
            time::sleep(Duration::from_millis(100)).await;
        }
    };
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{},_=stop_file=>{}}
    }
    #[cfg(not(unix))]
    tokio::select! {_=tokio::signal::ctrl_c()=>{},_=stop_file=>{}}
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
