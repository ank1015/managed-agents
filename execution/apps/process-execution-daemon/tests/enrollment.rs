use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const BIN: &str = env!("CARGO_BIN_EXE_process-execution-daemon");
const MACHINE: &str = "10000000-0000-4000-8000-000000000002";
fn secret(role: &str, version: u32) -> String {
    format!("{role}.{MACHINE}.{version}.{}", "a".repeat(43))
}
fn run(state: &Path, args: &[&str], input: Option<&str>) -> Output {
    let mut child = Command::new(BIN)
        .arg("--state-dir")
        .arg(state)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    }
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(20);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("CLI enrollment timed out");
        }
        thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}
fn backend(
    count: usize,
    handler: impl Fn(usize, &str, &str, Value) -> Value + Send + 'static,
) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(25);
        for number in 0..count {
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "missing enrollment request");
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            let headers = String::from_utf8(bytes).unwrap();
            let path = headers
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let header = |name: &str| {
                headers
                    .lines()
                    .filter_map(|l| l.split_once(':'))
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))
                    .unwrap()
                    .1
                    .trim()
            };
            let mut body = vec![0; header("content-length").parse().unwrap()];
            stream.read_exact(&mut body).unwrap();
            let response = handler(
                number,
                path,
                header("authorization"),
                serde_json::from_slice(&body).unwrap(),
            )
            .to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
    });
    (origin, worker)
}

#[test]
fn actual_cli_prints_approval_saves_only_daemon_secret_and_reenrolls_without_stdin() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let (origin, server) = backend(4, |n, path, auth, req| {
        assert_eq!(path, "/app/enroll");
        assert!(auth.starts_with("Bearer "));
        assert_eq!(auth.len(), 71);
        assert_eq!(req["protocolVersion"], 1);
        if n == 0 {
            assert_eq!(req["action"], "start");
            assert!(req["existingMachine"].is_null());
            json!({"protocolVersion":1,"registrationId":req["registrationId"],"status":"pending",
                "verificationUrl":"https://app.example/approve", "userCode":"TEST-1234", "intervalSeconds":1,
                "expiresAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 60000})
        } else if n == 3 {
            json!({"protocolVersion":1,"registrationId":req["registrationId"],"status":"denied"})
        } else {
            if n == 1 {
                assert_eq!(req["action"], "poll");
            } else {
                assert_eq!(req["action"], "start");
                assert_eq!(req["existingMachine"]["machineId"], MACHINE);
            }
            json!({"protocolVersion":1,"registrationId":req["registrationId"],"status":"approved",
                "gatewayUrl":"https://gateway.example","machineId":MACHINE,"daemonSecret":secret("md1", n as u32)})
        }
    });
    let output = run(
        &state,
        &[
            "register",
            "--url",
            &format!("{origin}/app/enroll"),
            "--name",
            "Test",
            "--allow-insecure-loopback",
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("https://app.example/approve"));
    assert!(stdout.contains("TEST-1234"));
    assert!(stdout.contains("Run `connect`"));
    assert!(!stdout.contains("md1."));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("Reading credential"));
    assert!(!state.join("execution-secret.json").exists());
    let first: Value =
        serde_json::from_slice(&std::fs::read(state.join("credential.json")).unwrap()).unwrap();
    assert_eq!(first["token"], secret("md1", 1));
    // Registration must not clear/migrate an existing journal.
    std::fs::write(state.join("journal.sqlite"), b"untouched journal fixture").unwrap();
    let output = run(&state, &["register"], None);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let second = std::fs::read(state.join("credential.json")).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&second).unwrap()["token"],
        secret("md1", 2)
    );
    assert_eq!(
        std::fs::read(state.join("journal.sqlite")).unwrap(),
        b"untouched journal fixture"
    );
    assert!(
        serde_json::from_slice::<Value>(&std::fs::read(state.join("enrollment.json")).unwrap())
            .unwrap()["pending"]
            .is_null()
    );
    let denied = run(&state, &["register"], None);
    assert!(!denied.status.success());
    assert_eq!(
        std::fs::read(state.join("credential.json")).unwrap(),
        second
    );
    server.join().unwrap();
}

#[test]
fn direct_registration_still_reads_management_stdin_and_saves_both_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let (origin, server) = backend(1, |_, path, auth, req| {
        assert_eq!(path, "/v1/machines");
        assert_eq!(auth, "Bearer test-management-secret");
        assert_eq!(req, json!({"machineId":MACHINE,"name":"Direct"}));
        json!({"machine":{"machineId":MACHINE},"daemonSecret":secret("md1",1),"executionSecret":secret("me1",1),"duplicate":false})
    });
    let result = run(
        directory.path(),
        &[
            "register",
            "--gateway-url",
            &origin,
            "--name",
            "Direct",
            "--machine-id",
            MACHINE,
            "--allow-insecure-loopback",
        ],
        Some("test-management-secret\n"),
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!String::from_utf8_lossy(&result.stdout).contains("md1."));
    assert!(!String::from_utf8_lossy(&result.stdout).contains("me1."));
    assert!(!String::from_utf8_lossy(&result.stderr).contains("test-management-secret"));
    assert!(directory.path().join("credential.json").exists());
    assert!(directory.path().join("execution-secret.json").exists());
    assert!(!directory.path().join("enrollment.json").exists());
    server.join().unwrap();
}

#[test]
fn modes_do_not_mix_and_missing_app_url_does_not_prompt_for_a_secret() {
    let directory = tempfile::tempdir().unwrap();
    for args in [
        vec!["register"],
        vec!["register", "--gateway-url", "https://gateway.example"],
        vec![
            "register",
            "--url",
            "https://app.example/enroll",
            "--gateway-url",
            "https://gateway.example",
            "--name",
            "Test",
        ],
    ] {
        let output = run(directory.path(), &args, None);
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("Reading credential"));
        assert!(!directory.path().join("credential.json").exists());
    }
}
