use process_execution_core::{Config, ErrorCode, ProcessExecutionCore, Request};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use uuid::Uuid;

fn core(dir: &Path, change: impl FnOnce(&mut Config)) -> ProcessExecutionCore {
    let mut config = Config::new(dir);
    config.termination_grace = Duration::from_millis(20);
    config.retention.sweep_interval = Duration::from_secs(60);
    change(&mut config);
    ProcessExecutionCore::new(config).unwrap()
}

async fn call(
    core: &ProcessExecutionCore,
    id: &str,
    operation: &str,
    params: Value,
) -> process_execution_core::Result<Value> {
    core.execute(
        serde_json::from_value::<Request>(json!({
            "request_id":id, "operation":{"operation":operation,"params":params}
        }))
        .unwrap(),
    )
    .await
}

fn command(cwd: &Path, script: &str) -> Value {
    json!({"cwd":cwd,"command":{"type":"shell","script":script},"completion":{"mode":"yield","wait_ms":250}})
}

fn repl(cwd: &Path, label: &str, code: &str) -> Value {
    json!({"target":{"type":"create","runtime":"node","cwd":cwd,"env":{"EXECUTION_TEST_LABEL":label}},
        "cells":[{"id":"a","code":code}],"completion":{"mode":"finished","timeout_ms":5000}})
}

#[tokio::test]
async fn command_contexts_and_request_identity_are_global() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let core = core(dir.path(), |_| {});
    let mut first = command(dir.path(), "printf '%s' \"$EXECUTION_TEST_LABEL\" > marker");
    first["env"] = json!({"EXECUTION_TEST_LABEL":"first"});
    let mut second = first.clone();
    second["cwd"] = json!(other.path());
    second["env"] = json!({"EXECUTION_TEST_LABEL":"second"});
    let (a, b) = tokio::join!(
        call(&core, "first", "execution.exec", first.clone()),
        call(&core, "second", "execution.exec", second.clone())
    );
    assert_eq!(a.unwrap()["exit_code"], 0);
    assert_eq!(b.unwrap()["exit_code"], 0);
    assert_eq!(std::fs::read(dir.path().join("marker")).unwrap(), b"first");
    assert_eq!(
        std::fs::read(other.path().join("marker")).unwrap(),
        b"second"
    );
    assert_eq!(
        call(&core, "first", "execution.exec", second)
            .await
            .unwrap_err()
            .code,
        ErrorCode::IdempotencyConflict
    );
    let read = call(
        &core,
        "read",
        "filesystem.read",
        json!({"cwd":other.path(),"path":"marker"}),
    )
    .await
    .unwrap();
    assert_eq!(read["text"], "second");
    core.shutdown().await.unwrap();
    // Shutdown blocks new work, while the global ledger can still replay completed requests.
    assert_eq!(
        call(&core, "first", "execution.exec", first.clone())
            .await
            .unwrap()["exit_code"],
        0
    );
    assert_eq!(
        call(&core, "late", "execution.exec", first)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unavailable
    );
}

#[tokio::test]
async fn global_process_limit_and_expired_receipt_keep_live_process_controllable() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let core = core(dir.path(), |c| {
        c.max_processes = 1;
        c.retention.delivered_receipts = Duration::ZERO;
    });
    let args = command(dir.path(), "sleep 30");
    let first = call(&core, "start", "execution.exec", args.clone())
        .await
        .unwrap();
    Uuid::parse_str(first["session_id"].as_str().unwrap()).unwrap();
    core.mark_delivered("start").unwrap();
    core.sweep().await;
    assert_eq!(
        call(&core, "start", "execution.exec", args)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ResultExpired
    );
    // A different cwd cannot evade the global process limit.
    assert_eq!(
        call(
            &core,
            "blocked",
            "execution.exec",
            command(other.path(), "sleep 30")
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ResourceLimit
    );
    core.cancel("start").unwrap();
    let end = call(
        &core,
        "poll",
        "execution.interact",
        json!({"session_id":first["session_id"],"input":{"type":"none"}}),
    )
    .await
    .unwrap();
    assert_eq!(end["state"], "finished");
    assert_eq!(end["reason"], "terminated");
    let next = call(
        &core,
        "next",
        "execution.exec",
        command(other.path(), "sleep 30"),
    )
    .await
    .unwrap();
    assert_ne!(first["session_id"], next["session_id"]);
    assert_eq!(
        call(
            &core,
            "close",
            "execution.close",
            json!({"session_id":next["session_id"]})
        )
        .await
        .unwrap(),
        json!({"state":"closed"})
    );
    core.shutdown().await.unwrap();
}

#[tokio::test]
async fn repl_launch_context_is_used_by_helpers_and_reset_and_limits_are_global() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let core = core(dir.path(), |c| c.max_repls = 1);
    let code = "await runtime.exec('printf %s \"$EXECUTION_TEST_LABEL\" > marker'); await runtime.write('helper', process.env.EXECUTION_TEST_LABEL); var retained = 42;";
    let first = call(
        &core,
        "create",
        "repl.execute",
        repl(other.path(), "one", code),
    )
    .await
    .unwrap();
    assert_eq!(first["state"], "succeeded", "{first}");
    Uuid::parse_str(first["session"].as_str().unwrap()).unwrap();
    assert_eq!(std::fs::read(other.path().join("marker")).unwrap(), b"one");
    assert_eq!(std::fs::read(other.path().join("helper")).unwrap(), b"one");
    assert!(!dir.path().join("marker").exists());
    assert_eq!(
        call(
            &core,
            "capacity",
            "repl.execute",
            repl(dir.path(), "two", "1")
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ResourceLimit
    );
    let reset = call(
        &core,
        "reset",
        "repl.reset",
        json!({"session":first["session"]}),
    )
    .await
    .unwrap();
    assert_ne!(first["session"], reset["session"]);
    let next = call(&core, "after-reset", "repl.execute", json!({"target":{"type":"existing","session":reset["session"]},
        "cells":[{"id":"a","code":"await runtime.write('reset', process.env.EXECUTION_TEST_LABEL + ':' + typeof retained)"}],
        "completion":{"mode":"finished","timeout_ms":5000}})).await.unwrap();
    assert_eq!(next["state"], "succeeded", "{next}");
    assert_eq!(
        std::fs::read(other.path().join("reset")).unwrap(),
        b"one:undefined"
    );
    call(
        &core,
        "close",
        "repl.close",
        json!({"session":reset["session"]}),
    )
    .await
    .unwrap();
    let replacement = call(
        &core,
        "replacement",
        "repl.execute",
        repl(dir.path(), "two", "process.env.EXECUTION_TEST_LABEL"),
    )
    .await
    .unwrap();
    assert_eq!(replacement["state"], "succeeded");
    core.shutdown().await.unwrap();
}

#[tokio::test]
async fn closed_repl_output_expires_without_expiring_live_interpreters() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path(), |c| c.retention.unread_results = Duration::ZERO);
    let first = call(
        &core,
        "create",
        "repl.execute",
        repl(dir.path(), "one", "var retained = 42"),
    )
    .await
    .unwrap();
    core.sweep().await;
    let second = call(
        &core,
        "use",
        "repl.execute",
        json!({"target":{"type":"existing","session":first["session"]},
        "cells":[{"id":"b","code":"retained"}],"completion":{"mode":"finished","timeout_ms":5000}}),
    )
    .await
    .unwrap();
    assert_eq!(second["state"], "succeeded");
    call(
        &core,
        "close",
        "repl.close",
        json!({"session":first["session"]}),
    )
    .await
    .unwrap();
    core.sweep().await;
    assert_eq!(
        call(
            &core,
            "collect",
            "repl.collect",
            json!({"session":first["session"],"execution_id":first["execution_id"],"wait_ms":0})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::SessionLost
    );
    // Its delivered request result can still replay independently of session output retention.
    assert_eq!(
        first,
        call(
            &core,
            "create",
            "repl.execute",
            repl(dir.path(), "one", "var retained = 42")
        )
        .await
        .unwrap()
    );
    core.shutdown().await.unwrap();
}

#[tokio::test]
async fn restart_rejects_old_uuid_handles_and_invalid_cwd_does_not_use_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let first_core = core(dir.path(), |_| {});
    let process = call(
        &first_core,
        "start",
        "execution.exec",
        command(dir.path(), "sleep 30"),
    )
    .await
    .unwrap();
    let interpreter = call(
        &first_core,
        "repl",
        "repl.execute",
        repl(dir.path(), "one", "1"),
    )
    .await
    .unwrap();
    first_core.shutdown().await.unwrap();
    let next = core(dir.path(), |c| c.max_processes = 1);
    assert_ne!(first_core.generation(), next.generation());
    assert_eq!(
        call(
            &next,
            "old-process",
            "execution.interact",
            json!({"session_id":process["session_id"],"input":{"type":"none"}})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::SessionClosed
    );
    assert_eq!(call(&next, "old-repl", "repl.collect", json!({"session":interpreter["session"],"execution_id":interpreter["execution_id"],"wait_ms":0})).await.unwrap_err().code, ErrorCode::SessionLost);
    let mut invalid = command(Path::new("relative"), "sleep 30");
    invalid["output"] = json!({"retain_full_output":true});
    let artifacts = dir
        .path()
        .join(".execution-artifacts")
        .join(format!("runtime-{}", next.generation()));
    let before = std::fs::read_dir(&artifacts).unwrap().count();
    assert_eq!(
        call(&next, "invalid", "execution.exec", invalid)
            .await
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(std::fs::read_dir(&artifacts).unwrap().count(), before);
    let new = call(
        &next,
        "new",
        "execution.exec",
        command(dir.path(), "sleep 30"),
    )
    .await
    .unwrap();
    assert_ne!(process["session_id"], new["session_id"]);
    next.shutdown().await.unwrap();
}
