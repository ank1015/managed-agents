use super::*;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

type Calls = Arc<Mutex<Vec<(String, Value)>>>;
type Handler = Box<dyn Fn(usize, &str, &Value) -> (u16, Value) + Send>;
async fn server(handler: Handler) -> (String, Calls, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/app/enroll", listener.local_addr().unwrap());
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let saved = calls.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            let (headers, offset, length) = loop {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8(bytes[..end].to_vec())
                        .unwrap()
                        .to_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    break (headers, end + 4, length);
                }
            };
            while bytes.len() < offset + length {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
            }
            assert!(headers.starts_with("post /app/enroll http/1.1"));
            let auth = headers
                .lines()
                .find_map(|l| l.strip_prefix("authorization: bearer "))
                .unwrap();
            let request: Value = serde_json::from_slice(&bytes[offset..offset + length]).unwrap();
            let number = saved.lock().unwrap().len();
            let (status, response) = handler(number, auth, &request);
            saved.lock().unwrap().push((auth.to_owned(), request));
            let body = response.to_string();
            stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nRetry-After: 1\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    (url, calls, task)
}
fn pending(req: &Value) -> Value {
    json!({"protocolVersion":1,"registrationId":req["registrationId"],"status":"pending",
        "verificationUrl":"https://app.example/approve?id=public-code","userCode":"ABCD-1234",
        "expiresAt":store::now()+60000,"intervalSeconds":1})
}
fn approved(req: &Value, machine: Uuid, version: u64) -> Value {
    json!({"protocolVersion":1,"registrationId":req["registrationId"],"status":"approved",
        "gatewayUrl":"https://gateway.example","machineId":machine,
        "daemonSecret":format!("md1.{machine}.{version}.{}", "a".repeat(43))})
}
fn directory() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    store::private_directory(dir.path()).unwrap();
    dir
}

#[tokio::test]
async fn approval_polling_and_reenrollment_keep_secrets_and_identity_separate() {
    let dir = directory();
    let machine = Uuid::new_v4();
    let (url, calls, task) = server(Box::new(move |n, auth, req| {
        assert_eq!(auth.len(), 64);
        assert!(!req.to_string().contains(auth));
        if n == 0 {
            assert_eq!(req["action"], "start");
            assert!(req["existingMachine"].is_null());
            (200, pending(req))
        } else if n == 1 {
            assert_eq!(req["action"], "poll");
            (200, approved(req, machine, 1))
        } else {
            assert_eq!(req["action"], "start");
            assert_eq!(req["existingMachine"]["machineId"], machine.to_string());
            assert!(!req.to_string().contains("md1."));
            (200, approved(req, machine, 2))
        }
    }))
    .await;
    let first = authorize(dir.path(), Some(&url), Some("Test machine"), true)
        .await
        .unwrap();
    assert!(!dir.path().join("credential.json").exists());
    // Approval survives a crash before the credential is installed, without
    // asking the app to rotate again or waiting for another browser approval.
    let resumed = authorize(dir.path(), None, None, false).await.unwrap();
    assert_eq!(resumed.credential.token, first.credential.token);
    assert_eq!(calls.lock().unwrap().len(), 2);
    first.credential.save(dir.path()).unwrap();
    first.finish(dir.path()).unwrap();
    let second = authorize(dir.path(), None, None, false).await.unwrap();
    assert_ne!(second.credential.token, first.credential.token);
    second.credential.save(dir.path()).unwrap();
    second.finish(dir.path()).unwrap();
    assert_eq!(
        Credential::load(dir.path()).unwrap().token,
        second.credential.token
    );
    assert!(!dir.path().join("execution-secret.json").exists());
    let records = calls.lock().unwrap();
    assert_eq!(records[0].0, records[1].0);
    assert_eq!(
        records[0].1["registrationId"],
        records[1].1["registrationId"]
    );
    assert_ne!(records[0].0, records[2].0);
    assert_ne!(
        records[0].1["registrationId"],
        records[2].1["registrationId"]
    );
    let state: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
    assert!(state["pending"].is_null());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in [FILE, "credential.json"] {
            assert_eq!(
                std::fs::metadata(dir.path().join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    task.abort();
}

#[tokio::test]
async fn interrupted_start_recovers_same_attempt_and_explicit_denial_allows_fresh_attempt() {
    let dir = directory();
    let (url, calls, task) = server(Box::new(|_, _, req| {
        (
            200,
            json!({"protocolVersion":1,"registrationId":req["registrationId"],"status":"denied"}),
        )
    }))
    .await;
    let saved = load(dir.path(), Some(&url), None, true).unwrap();
    let id = saved.pending.as_ref().unwrap().registration_id;
    assert!(
        load(
            dir.path(),
            Some("https://other.example/register"),
            None,
            false
        )
        .is_err()
    );
    assert!(
        authorize(dir.path(), None, None, false)
            .await
            .unwrap_err_string()
            .contains("denied")
    );
    assert_eq!(calls.lock().unwrap()[0].1["registrationId"], id.to_string());
    assert!(authorize(dir.path(), None, None, false).await.is_err());
    assert_ne!(calls.lock().unwrap()[1].1["registrationId"], id.to_string());
    assert!(!dir.path().join("credential.json").exists());
    task.abort();
}

// Avoid requiring Debug on values that deliberately contain private credentials.
trait ErrorString {
    fn unwrap_err_string(self) -> String;
}
impl<T> ErrorString for Result<T> {
    fn unwrap_err_string(self) -> String {
        match self {
            Ok(_) => panic!("expected rejection"),
            Err(e) => e.to_string(),
        }
    }
}

#[tokio::test]
async fn invalid_responses_never_replace_existing_credentials() {
    for case in [
        "machine",
        "gateway",
        "role",
        "identity",
        "version",
        "extra",
        "redirect",
        "oversize",
        "invalid_json_shape",
        "interval",
        "url",
    ] {
        let dir = directory();
        let machine = Uuid::new_v4();
        let old = http::credential(
            "https://gateway.example",
            machine,
            format!("md1.{machine}.1.{}", "x".repeat(43)),
            false,
        )
        .unwrap();
        old.save(dir.path()).unwrap();
        let before = std::fs::read(dir.path().join("credential.json")).unwrap();
        let (url, _, task) = server(Box::new(move |_, _, req| {
            let mut reply = approved(req, machine, 2);
            match case {
                "machine" => reply = approved(req, Uuid::new_v4(), 2),
                "gateway" => reply["gatewayUrl"] = json!("https://other.example"),
                "role" => {
                    reply["daemonSecret"] = json!(format!("me1.{machine}.2.{}", "a".repeat(43)))
                }
                "identity" => reply["registrationId"] = json!(Uuid::new_v4()),
                "version" => reply["protocolVersion"] = json!(2),
                "extra" => reply["executionSecret"] = json!("must-not-be-sent-to-daemon"),
                "redirect" => return (302, reply),
                "oversize" => reply["daemonSecret"] = json!("x".repeat(17000)),
                "invalid_json_shape" => reply = json!("not-an-object"),
                "interval" => {
                    reply = pending(req);
                    reply["intervalSeconds"] = json!(0);
                }
                "url" => {
                    reply = pending(req);
                    reply["verificationUrl"] = json!("javascript:alert(1)");
                }
                _ => unreachable!(),
            }
            (200, reply)
        }))
        .await;
        assert!(
            authorize(dir.path(), Some(&url), None, true).await.is_err(),
            "{case}"
        );
        assert_eq!(
            std::fs::read(dir.path().join("credential.json")).unwrap(),
            before,
            "{case}"
        );
        task.abort();
    }
}

#[tokio::test]
async fn expiry_and_transient_server_errors_are_bounded_and_retry_safe() {
    let dir = directory();
    let machine = Uuid::new_v4();
    let (url, calls, task) = server(Box::new(move |n, _, req| {
        if n == 0 {
            (503, json!({}))
        } else {
            (200, approved(req, machine, 1))
        }
    }))
    .await;
    authorize(dir.path(), Some(&url), None, true).await.unwrap();
    {
        let records = calls.lock().unwrap();
        assert_eq!(records[0], records[1]);
    }
    task.abort();

    let dir = directory();
    let (url, _, task) = server(Box::new(|_, _, req| {
        let mut reply = pending(req);
        reply["expiresAt"] = json!(store::now() + 100);
        (200, reply)
    }))
    .await;
    let started = Instant::now();
    assert!(
        authorize(dir.path(), Some(&url), None, true)
            .await
            .unwrap_err_string()
            .contains("expired")
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    let saved: State =
        serde_json::from_slice(&std::fs::read(dir.path().join(FILE)).unwrap()).unwrap();
    assert!(saved.pending.is_none());
    task.abort();
}

#[test]
fn arbitrary_https_endpoints_are_supported_but_credentials_and_unsafe_urls_are_not() {
    assert!(
        endpoint(
            "https://my-app.example/api/machines/register?tenant=example",
            false
        )
        .is_ok()
    );
    assert!(endpoint("http://127.0.0.1:1234/enroll", true).is_ok());
    for url in [
        "http://remote.example/enroll",
        "http://127.0.0.1/enroll",
        "https://user:secret@app.example/enroll",
        "file:///tmp/enroll",
        "https://app.example/enroll#secret",
        "https://app.example/\nspoof",
    ] {
        assert!(endpoint(url, false).is_err(), "{url}");
    }
}

#[tokio::test]
async fn lost_response_body_retries_the_persisted_attempt() {
    let dir = directory();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/app/enroll", listener.local_addr().unwrap());
    let state = load(dir.path(), Some(&url), None, true).unwrap();
    let before = std::fs::read(dir.path().join(FILE)).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4096];
        assert!(stream.read(&mut bytes).await.unwrap() > 0);
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n{").await.unwrap();
        // Drop the socket partway through a nominally successful response.
    });
    let reply = exchange(
        &http::client().unwrap(),
        &endpoint(&url, true).unwrap(),
        state.pending.as_ref().unwrap(),
        true,
    )
    .await
    .unwrap();
    assert!(matches!(reply, Response::Retry(5)));
    assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), before);
    server.await.unwrap();
}
