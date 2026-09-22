use super::*;
use process_execution_core::{ErrorCode, Request};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{WebSocketStream, accept_async};

type Peer = WebSocketStream<TcpStream>;

async fn put(peer: &mut Peer, frame: Value) {
    peer.send(Message::Text(frame.to_string().into()))
        .await
        .unwrap();
}

async fn get(peer: &mut Peer) -> Value {
    loop {
        match peer.next().await.unwrap().unwrap() {
            Message::Text(raw) if raw == "execution:ping" => {
                peer.send(Message::Text("execution:pong".into()))
                    .await
                    .unwrap();
            }
            Message::Text(raw) => return serde_json::from_str(&raw).unwrap(),
            Message::Ping(data) => peer.send(Message::Pong(data)).await.unwrap(),
            frame => panic!("unexpected frame: {frame:?}"),
        }
    }
}

async fn accept(listener: &TcpListener, machine: Uuid, generation: Uuid) -> Peer {
    let (socket, _) = listener.accept().await.unwrap();
    let mut peer = accept_async(socket).await.unwrap();
    put(
        &mut peer,
        json!({"type":"welcome","protocolVersion":1,"machineId":machine}),
    )
    .await;
    let hello = get(&mut peer).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["runtimeGeneration"], generation.to_string());
    put(
        &mut peer,
        json!({"type":"ready","runtimeGeneration":generation}),
    )
    .await;
    peer
}

fn request(generation: Uuid, operation: &str, params: Value) -> Incoming {
    let id = Uuid::new_v4().to_string();
    let operation = json!({"operation":operation,"params":params});
    Incoming {
        kind: "request".into(),
        protocol_version: 1,
        dispatch_id: Uuid::new_v4(),
        request_id: id.clone(),
        request_hash: protocol::hash(&json!({"id":id,"operation":operation})).unwrap(),
        runtime_generation: generation,
        operation,
        routing_envelope: id,
    }
}

async fn exchange(peer: &mut Peer, req: &Incoming) -> Value {
    put(peer, serde_json::to_value(req).unwrap()).await;
    let mut accepted = false;
    loop {
        let frame = get(peer).await;
        match frame["type"].as_str() {
            Some("accepted") => {
                assert_eq!(frame["dispatchId"], req.dispatch_id.to_string());
                accepted = true;
            }
            Some("result") if frame["routingEnvelope"] == req.routing_envelope => {
                assert!(accepted);
                let outcome = &frame["outcome"];
                put(peer, json!({"type":"result_ack","deliveryId":frame["deliveryId"],
                    "requestId":req.request_id,"requestHash":req.request_hash,"resultHash":protocol::hash(outcome).unwrap()})).await;
                return outcome.clone();
            }
            Some("result") => {} // A previously sent delivery can already be in flight.
            _ => panic!("unexpected reply: {frame}"),
        }
    }
}

#[tokio::test]
async fn capacity_nack_retries_the_same_result_promptly_without_reexecuting() {
    time::timeout(Duration::from_secs(15), async {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config {
            cwd: directory.path().to_owned(),
            allow_insecure_loopback: true,
            ..Config::default()
        };
        assert_eq!(config.delivery_ack_timeout_ms, 10000);
        let core = ProcessExecutionCore::new(config.core(directory.path())).unwrap();
        let generation = core.generation();
        let (faults, mut failures) = mpsc::unbounded_channel();
        let engine = Engine {
            core: core.clone(),
            journal: Arc::new(Journal::open(directory.path()).unwrap()),
            tasks: TaskTracker::new(),
            config,
            faults,
            ready: Arc::new(Notify::new()),
        };
        let machine = Uuid::new_v4();
        let mut credential = Credential {
            gateway_url: format!("http://{}", listener.local_addr().unwrap()),
            machine_id: machine,
            token: "local-test-token".into(),
        };
        let req = request(
            generation,
            "filesystem.write",
            json!({
                "cwd": directory.path(), "path": "once.txt", "create_parents": true,
                "content": {"type":"base64", "data":"b25jZQo="}
            }),
        );
        let peer = async {
            let mut peer = accept(&listener, machine, generation).await;
            put(&mut peer, serde_json::to_value(&req).unwrap()).await;
            assert_eq!(get(&mut peer).await["type"], "accepted");
            let first = get(&mut peer).await;
            assert_eq!(first["type"], "result");
            assert_eq!(first["outcome"]["status"], "ok");
            assert_eq!(
                std::fs::read(directory.path().join("once.txt")).unwrap(),
                b"once\n"
            );
            // Missing acknowledgment alone must not activate capacity backoff.
            assert!(
                time::timeout(Duration::from_millis(350), get(&mut peer))
                    .await
                    .is_err()
            );
            std::fs::write(directory.path().join("once.txt"), b"newer\n").unwrap();
            for _ in 0..2 {
                put(
                    &mut peer,
                    json!({"type":"result_nack","deliveryId":first["deliveryId"],
                    "error":{"code":"DELIVERY_CAPACITY","retryable":true}}),
                )
                .await;
                let replay = time::timeout(Duration::from_secs(2), get(&mut peer))
                    .await
                    .expect("capacity rejection must not wait for the ten-second ACK timeout");
                assert_eq!(replay, first);
                assert_eq!(
                    std::fs::read(directory.path().join("once.txt")).unwrap(),
                    b"newer\n"
                );
            }
            put(
                &mut peer,
                json!({"type":"result_ack","deliveryId":first["deliveryId"],
                "requestId":req.request_id,"requestHash":req.request_hash,
                "resultHash":protocol::hash(&first["outcome"]).unwrap()}),
            )
            .await;
            exchange(
                &mut peer,
                &request(generation, "runtime.capabilities", json!({})),
            )
            .await;
            peer.close(None).await.unwrap();
        };
        let (_, disconnected) =
            tokio::join!(peer, connection(directory.path(), &mut credential, &engine));
        assert!(disconnected.is_err());
        core.shutdown().await.unwrap();
        engine.tasks.close();
        engine.tasks.wait().await;
        assert!(failures.try_recv().is_err());
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn reconnect_replays_delivered_results_and_preserves_uuid_process_control() {
    time::timeout(Duration::from_secs(15), async {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config {
            cwd: directory.path().to_owned(),
            allow_insecure_loopback: true,
            core_receipt_retention_seconds: 0,
            max_processes: 1,
            delivery_retry_ms: 10,
            delivery_ack_timeout_ms: 10,
            ..Config::default()
        };
        let core = ProcessExecutionCore::new(config.core(directory.path())).unwrap();
        let generation = core.generation();
        let (faults, mut failures) = mpsc::unbounded_channel();
        let engine = Engine {
            core: core.clone(), journal: Arc::new(Journal::open(directory.path()).unwrap()),
            tasks: TaskTracker::new(), config, faults, ready: Arc::new(Notify::new()),
        };
        let machine = Uuid::new_v4();
        let mut credential = Credential {
            gateway_url: format!("http://{}", listener.local_addr().unwrap()),
            machine_id: machine, token: "local-test-token".into(),
        };
        let params = json!({"cwd":directory.path(),"command":{"type":"shell","script":"printf x >> marker; sleep 30"},"completion":{"mode":"yield","wait_ms":250}});
        let mut start = request(generation, "execution.exec", params);
        let mut stale = start.clone();
        stale.runtime_generation = Uuid::new_v4();
        assert_eq!(engine.request(stale).unwrap()["error"]["code"], "RUNTIME_GENERATION_MISMATCH");
        assert!(!directory.path().join("marker").exists());

        let peer = async {
            let mut peer = accept(&listener, machine, generation).await;
            let result = exchange(&mut peer, &start).await;
            assert_eq!(result["status"], "ok");
            assert_eq!(result["result"]["state"], "running");
            Uuid::parse_str(result["result"]["session_id"].as_str().unwrap()).unwrap();
            // This round trip ensures the preceding result_ack was processed.
            exchange(&mut peer, &request(generation, "runtime.capabilities", json!({}))).await;
            peer.close(None).await.unwrap();
            result
        };
        let (first, disconnected) = tokio::join!(peer, connection(directory.path(), &mut credential, &engine));
        assert!(disconnected.is_err());
        core.sweep().await;
        let native = Request { request_id: start.request_id.clone(), operation: serde_json::from_value(start.operation.clone()).unwrap() };
        assert_eq!(core.execute(native).await.unwrap_err().code, ErrorCode::ResultExpired);
        // The durable daemon journal still replays the exact result after reconnect.
        start.dispatch_id = Uuid::new_v4();
        let peer = async {
            let mut peer = accept(&listener, machine, generation).await;
            assert_eq!(exchange(&mut peer, &start).await, first);
            assert_eq!(std::fs::read(directory.path().join("marker")).unwrap(), b"x");
            let cancel = request(generation, "request.cancel", json!({"request_id":start.request_id}));
            assert_eq!(exchange(&mut peer, &cancel).await, json!({"status":"ok","result":{"state":"cancelled"}}));
            let poll = request(generation, "execution.interact", json!({"session_id":first["result"]["session_id"],"input":{"type":"none"}}));
            let end = exchange(&mut peer, &poll).await;
            assert_eq!(end["result"]["state"], "finished");
            assert_eq!(end["result"]["reason"], "terminated");
            exchange(&mut peer, &request(generation, "runtime.capabilities", json!({}))).await;
            peer.close(None).await.unwrap();
        };
        let (_, disconnected) = tokio::join!(peer, connection(directory.path(), &mut credential, &engine));
        assert!(disconnected.is_err());
        core.shutdown().await.unwrap();
        engine.tasks.close();
        engine.tasks.wait().await;
        assert!(failures.try_recv().is_err());
    }).await.unwrap();
}
