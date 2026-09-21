use base64::{Engine, engine::general_purpose::STANDARD};
use process_execution_core::*;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

struct Fixture {
    core: ProcessExecutionCore,
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        Self::configured(|_| {})
    }
    fn configured(change: impl FnOnce(&mut Config)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::new(dir.path());
        config.termination_grace = Duration::from_millis(20);
        config.output_drain_timeout = Duration::from_millis(100);
        config.interrupt_grace = Duration::from_millis(200);
        config.retention.sweep_interval = Duration::from_millis(20);
        change(&mut config);
        let core = ProcessExecutionCore::new(config).unwrap();
        Self { core, dir }
    }
    async fn call(&self, id: &str, op: &str, mut params: Value) -> Result<Value> {
        if matches!(
            op,
            "execution.exec" | "filesystem.read" | "filesystem.write" | "filesystem.patch"
        ) && params["cwd"].is_null()
        {
            params["cwd"] = json!(self.dir.path());
        }
        if op == "repl.execute"
            && params["target"]["type"] == "create"
            && params["target"]["cwd"].is_null()
        {
            params["target"]["cwd"] = json!(self.dir.path());
        }
        let operation = serde_json::from_value(json!({"operation":op,"params":params})).unwrap();
        self.core
            .execute(Request {
                request_id: id.into(),
                operation,
            })
            .await
    }
    async fn exec(&self, id: &str, command: &str) -> Value {
        self.call(id,"execution.exec",json!({"command":{"type":"shell","script":command,"login":false},"cwd":null,"completion":{"mode":"finished","timeout_ms":5000}})).await.unwrap()
    }
    async fn repl(&self, id: &str, target: Value, cells: Value) -> Value {
        self.call(id,"repl.execute",json!({"target":target,"cells":cells,"completion":{"mode":"finished","timeout_ms":15000}})).await.unwrap()
    }
}
fn output(result: &Value) -> String {
    result["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
}
fn existing(result: &Value) -> Value {
    json!({"type":"existing","session":result["session"]})
}

#[tokio::test]
async fn shell_results_and_replay_are_immutable() {
    let f = Fixture::new();
    let first = f
        .exec("once", "printf 'hello'; printf 'err' >&2; exit 7")
        .await;
    assert_eq!(first["exit_code"], 7);
    assert!(first["output"].as_str().unwrap().contains("hello"));
    assert_eq!(
        first,
        f.exec("once", "printf 'hello'; printf 'err' >&2; exit 7")
            .await
    );
    assert_eq!(
        f.call(
            "once",
            "execution.exec",
            json!({"command":{"type":"shell","script":"false"},"cwd":null})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::IdempotencyConflict
    );
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn concurrent_duplicate_starts_execute_once() {
    let f = Fixture::new();
    let (a, b) = tokio::join!(
        f.exec("once", "printf x >> marker; sleep 0.1; cat marker"),
        f.exec("once", "printf x >> marker; sleep 0.1; cat marker")
    );
    assert_eq!(a, b);
    assert_eq!(std::fs::read(f.dir.path().join("marker")).unwrap(), b"x");
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn yielded_command_poll_and_final_close() {
    let f = Fixture::new();
    let started=f.call("start","execution.exec",json!({"command":{"type":"shell","script":"printf first; sleep 0.4; printf second"},"cwd":null,"completion":{"mode":"yield","wait_ms":250}})).await.unwrap();
    assert_eq!(started["state"], "running");
    assert_eq!(started["output"], "first");
    let result = f
        .call(
            "poll",
            "execution.interact",
            json!({"session_id":started["session_id"],"input":{"type":"none"},"wait_ms":5000}),
        )
        .await
        .unwrap();
    assert_eq!(result["output"], "second");
    assert_eq!(result["exit_code"], 0);
    assert_eq!(
        f.call(
            "closed",
            "execution.interact",
            json!({"session_id":started["session_id"],"input":{"type":"none"}})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::SessionClosed
    );
    assert_eq!(
        result,
        f.call(
            "poll",
            "execution.interact",
            json!({"session_id":started["session_id"],"input":{"type":"none"},"wait_ms":5000})
        )
        .await
        .unwrap()
    );
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn pty_input_and_pipe_interrupt() {
    let f = Fixture::new();
    let start=f.call("pty","execution.exec",json!({"command":{"type":"shell","script":"read answer; printf 'received:%s' \"$answer\""},"cwd":null,"tty":true,"completion":{"mode":"yield","wait_ms":250}})).await.unwrap();
    let input=f.call("input","execution.interact",json!({"session_id":start["session_id"],"input":{"type":"text","text":"hello\n"},"wait_ms":1000})).await.unwrap();
    assert!(input["output"].as_str().unwrap().contains("received:hello"));
    let start=f.call("pipe","execution.exec",json!({"command":{"type":"shell","script":"sleep 30"},"cwd":null,"completion":{"mode":"yield","wait_ms":250}})).await.unwrap();
    assert_eq!(
        f.call(
            "bad-input",
            "execution.interact",
            json!({"session_id":start["session_id"],"input":{"type":"text","text":"hello"}})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::StdinClosed
    );
    let stop=f.call("interrupt","execution.interact",json!({"session_id":start["session_id"],"input":{"type":"text","text":"\u{3}"},"wait_ms":1000})).await.unwrap();
    assert_eq!(stop["state"], "finished");
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn completion_timeout_and_caller_drop() {
    let f = Arc::new(Fixture::new());
    let timeout=f.call("timeout","execution.exec",json!({"command":{"type":"shell","script":"sleep 30"},"cwd":null,"completion":{"mode":"finished","timeout_ms":20}})).await.unwrap();
    assert_eq!(timeout["reason"], "timed_out");
    let other = f.clone();
    let waiter =
        tokio::spawn(async move { other.exec("drop", "sleep 0.15; printf done > marker").await });
    tokio::time::sleep(Duration::from_millis(40)).await;
    waiter.abort();
    let result = f.exec("drop", "sleep 0.15; printf done > marker").await;
    assert_eq!(result["exit_code"], 0);
    assert_eq!(std::fs::read(f.dir.path().join("marker")).unwrap(), b"done");
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn full_output_artifact_and_configurable_expiry() {
    let f = Fixture::configured(|c| c.retention.artifacts = Duration::from_millis(100));
    let result=f.call("log","execution.exec",json!({"command":{"type":"shell","script":"printf 'one\ntwo\nthree\n'"},"cwd":null,"completion":{"mode":"finished","timeout_ms":1000},"output":{"strategy":"tail","max_bytes":100,"max_lines":1,"retain_full_output":true}})).await.unwrap();
    assert_eq!(result["output"], "three\n");
    let path = result["artifact"]["path"].as_str().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"one\ntwo\nthree\n");
    tokio::time::sleep(Duration::from_millis(150)).await;
    f.core.sweep().await;
    assert!(!std::path::Path::new(path).exists());
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn filesystem_tools_and_images_in_single_operations() {
    let f = Fixture::new();
    f.call(
        "write",
        "filesystem.write",
        json!({"path":"a/b.txt","cwd":null,"content":{"type":"text","data":"one\ntwo\nthree"}}),
    )
    .await
    .unwrap();
    let read = f
        .call(
            "read",
            "filesystem.read",
            json!({"path":"a/b.txt","cwd":null,"offset":2,"limit":1}),
        )
        .await
        .unwrap();
    assert_eq!(read["text"], "two");
    assert_eq!(read["next_offset"], 3);
    let edit=f.call("edit","filesystem.patch",json!({"cwd":null,"patch":{"format":"text_replacements","files":[{"path":"a/b.txt","edits":[{"oldText":"two","newText":"TWO"}]}]}})).await.unwrap();
    assert_eq!(edit["status"], "applied");
    let patch=f.call("patch","filesystem.patch",json!({"cwd":null,"patch":{"format":"codex","text":"*** Begin Patch\n*** Add File: added.txt\n+hello\n*** End Patch"}})).await.unwrap();
    assert_eq!(patch["status"], "applied");
    let image = image::RgbImage::from_pixel(10, 20, image::Rgb([255, 0, 0]));
    image.save(f.dir.path().join("image.png")).unwrap();
    let read = f
        .call(
            "image",
            "filesystem.read",
            json!({"path":"image.png","cwd":null,"mode":"image","image_max_dimension":5}),
        )
        .await
        .unwrap();
    assert_eq!(read["image"]["height"], 5);
    assert!(
        !STANDARD
            .decode(read["image"]["data_base64"].as_str().unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(
        f.call(
            "not-image",
            "filesystem.read",
            json!({"path":"added.txt","cwd":null,"mode":"image"})
        )
        .await
        .is_err()
    );
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn read_and_image_allocation_limits() {
    let f = Fixture::configured(|c| {
        c.max_file_bytes = 100;
        c.max_image_pixels = 5;
    });
    std::fs::write(f.dir.path().join("big"), vec![b'a'; 101]).unwrap();
    assert_eq!(
        f.call(
            "big",
            "filesystem.read",
            json!({"path":"big","cwd":null,"offset":1,"limit":1})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ResourceLimit
    );
    image::RgbImage::new(3, 3)
        .save(f.dir.path().join("pixels.png"))
        .unwrap();
    assert_eq!(
        f.call(
            "pixels",
            "filesystem.read",
            json!({"path":"pixels.png","cwd":null})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ResourceLimit
    );
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn delivered_receipt_expires_without_repeating_effects() {
    let f = Fixture::configured(|c| c.retention.delivered_receipts = Duration::from_millis(20));
    f.exec("once", "printf x >> marker").await;
    f.core.mark_delivered("once").unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    f.core.sweep().await;
    assert_eq!(f.call("once","execution.exec",json!({"command":{"type":"shell","script":"printf x >> marker","login":false},"cwd":null,"completion":{"mode":"finished","timeout_ms":5000}})).await.unwrap_err().code,ErrorCode::ResultExpired);
    assert_eq!(std::fs::read(f.dir.path().join("marker")).unwrap(), b"x");
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn python_persistence_multicell_error_and_helpers() {
    let f = Fixture::new();
    let result = f
        .repl(
            "python",
            json!({"type":"create","runtime":"python"}),
            json!([{"id":"one","code":"x = 40"},{"id":"two","code":"x + 2"}]),
        )
        .await;
    assert_eq!(result["state"], "succeeded", "{result}");
    assert!(output(&result).contains("42"), "{result}");
    let later=f.repl("later",existing(&result),json!([{"id":"three","code":"x += 1\nraise ValueError('expected')"},{"id":"skip","code":"x = 0"}])).await;
    assert_eq!(later["cells"][1]["status"], "skipped");
    let check=f.repl("check",existing(&result),json!([{"id":"check","code":"print(x)\nawait runtime.write('from_python.txt', 'content')\nr = await runtime.exec('printf hello')\nprint(r['output'])"}])).await;
    assert_eq!(check["state"], "succeeded", "{check}");
    assert!(output(&check).contains("41"));
    assert!(output(&check).contains("hello"));
    assert_eq!(
        std::fs::read(f.dir.path().join("from_python.txt")).unwrap(),
        b"content"
    );
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn node_persistence_await_error_and_helpers() {
    let f = Fixture::new();
    let result=f.repl("node",json!({"type":"create","runtime":"node"}),json!([{"id":"one","code":"var x = await Promise.resolve(40);"},{"id":"two","code":"x + 2"}])).await;
    assert_eq!(result["state"], "succeeded", "{result}");
    assert!(output(&result).contains("42"), "{result}");
    let later=f.repl("later",existing(&result),json!([{"id":"error","code":"x++; throw Error('expected')"},{"id":"skip","code":"x=0"}])).await;
    assert_eq!(later["cells"][1]["status"], "skipped");
    let check=f.repl("check",existing(&result),json!([{"id":"check","code":"console.log(x); await runtime.write('from_node.txt','content'); var r = await runtime.exec('printf hello'); console.log(r.output)"}])).await;
    assert_eq!(check["state"], "succeeded", "{check}");
    assert!(output(&check).contains("41"));
    assert!(output(&check).contains("hello"));
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn repl_yield_collect_replay_reset_and_close() {
    let f = Fixture::new();
    let args = json!({"target":{"type":"create","runtime":"python"},"cells":[{"id":"cell","code":"import asyncio\nx = 123\nprint('first')\nawait asyncio.sleep(0.3)\nprint('second')"}],"completion":{"mode":"yield","wait_ms":50}});
    let result = f.call("yield", "repl.execute", args.clone()).await.unwrap();
    assert_eq!(result["state"], "running", "{result}");
    let poll_args =
        json!({"session":result["session"],"execution_id":result["execution_id"],"wait_ms":1000});
    let collected = f
        .call("collect", "repl.collect", poll_args.clone())
        .await
        .unwrap();
    assert_eq!(collected["state"], "succeeded");
    assert_eq!(
        collected,
        f.call("collect", "repl.collect", poll_args).await.unwrap()
    );
    assert_eq!(result, f.call("yield", "repl.execute", args).await.unwrap());
    let reset = f
        .call("reset", "repl.reset", json!({"session":result["session"]}))
        .await
        .unwrap();
    assert_ne!(reset["session"], result["session"]);
    let fresh = f
        .repl(
            "fresh",
            existing(&reset),
            json!([{"id":"test","code":"print('x' in globals())"}]),
        )
        .await;
    assert!(output(&fresh).contains("False"));
    f.call("close", "repl.close", json!({"session":reset["session"]}))
        .await
        .unwrap();
    assert_eq!(
        f.call(
            "lost",
            "repl.execute",
            json!({"target":existing(&reset),"cells":[{"id":"cell","code":"1"}]})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::SessionLost
    );
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn repl_image_output_and_runtime_image_helper() {
    let f = Fixture::new();
    image::RgbImage::new(3, 3)
        .save(f.dir.path().join("image.png"))
        .unwrap();
    let python=f.repl("python",json!({"type":"create","runtime":"python"}),json!([{"id":"image","code":"await runtime.display_image('image.png')\nfrom IPython.display import display, Image\ndisplay(Image(filename='image.png'))"}])).await;
    assert_eq!(python["state"], "succeeded", "{python}");
    assert!(
        python["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "image")
            .count()
            >= 2,
        "{python}"
    );
    let node = f
        .repl(
            "node",
            json!({"type":"create","runtime":"node"}),
            json!([{"id":"image","code":"await runtime.displayImage('image.png')"}]),
        )
        .await;
    assert_eq!(node["state"], "succeeded", "{node}");
    assert!(
        node["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "image")
    );
    f.core.shutdown().await.unwrap();
}
#[tokio::test]
async fn repl_interrupt_and_shutdown_terminate_live_resources() {
    let f = Fixture::new();
    let result=f.call("busy","repl.execute",json!({"target":{"type":"create","runtime":"node"},"cells":[{"id":"loop","code":"await new Promise(() => {})"}],"completion":{"mode":"yield","wait_ms":50}})).await.unwrap();
    f.call(
        "interrupt",
        "repl.interrupt",
        json!({"session":result["session"]}),
    )
    .await
    .unwrap();
    let end=f.call("collect","repl.collect",json!({"session":result["session"],"execution_id":result["execution_id"],"wait_ms":1000})).await.unwrap();
    assert_ne!(end["state"], "running");
    let python = f
        .repl(
            "python",
            json!({"type":"create","runtime":"python"}),
            json!([{"id":"state","code":"x = 1"}]),
        )
        .await;
    f.core.shutdown().await.unwrap();
    assert_eq!(
        f.call(
            "new",
            "repl.collect",
            json!({"session":python["session"],"execution_id":python["execution_id"],"wait_ms":0})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::Unavailable
    );
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn repl_fifo_queue_and_duplicate_cells_do_not_repeat_effects() {
    let f = Fixture::new();
    let first = f.call("start", "repl.execute", json!({"target":{"type":"create","runtime":"python"},"cells":[{"id":"a","code":"import asyncio\nx = []\nawait asyncio.sleep(0.2)\nx.append('first')"}],"completion":{"mode":"yield","wait_ms":10}})).await.unwrap();
    let cells = json!([{"id":"b","code":"x.append('second')\nprint(x)"}]);
    let (a, b) = tokio::join!(
        f.repl("next", existing(&first), cells.clone()),
        f.repl("next", existing(&first), cells)
    );
    assert_eq!(a, b);
    assert!(output(&a).contains("['first', 'second']"), "{a}");
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn unread_expiry_keeps_live_state_and_undelivered_receipts() {
    let f = Fixture::configured(|c| {
        c.retention.unread_results = Duration::from_millis(30);
        c.retention.delivered_receipts = Duration::from_millis(30);
    });
    let saved = f
        .repl(
            "saved",
            json!({"type":"create","runtime":"node"}),
            json!([{"id":"a","code":"var x = 42; x"}]),
        )
        .await;
    let exec = f.call("exec", "execution.exec",json!({"command":{"type":"shell","script":"sleep 1; printf alive"},"completion":{"mode":"yield","wait_ms":250}})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    f.core.sweep().await;
    assert_eq!(
        f.call(
            "expired",
            "repl.collect",
            json!({"session":saved["session"],"execution_id":saved["execution_id"],"wait_ms":0})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ResultExpired
    );
    assert_eq!(
        saved,
        f.repl(
            "saved",
            json!({"type":"create","runtime":"node"}),
            json!([{"id":"a","code":"var x = 42; x"}])
        )
        .await
    );
    let alive = f
        .repl("alive", existing(&saved), json!([{"id":"b","code":"x"}]))
        .await;
    assert!(output(&alive).contains("42"));
    let end = f
        .call(
            "poll",
            "execution.interact",
            json!({"session_id":exec["session_id"],"input":{"type":"none"}}),
        )
        .await
        .unwrap();
    assert_eq!(end["output"], "alive");
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelling_a_cell_also_cancels_its_native_helper() {
    let f = Fixture::new();
    let result=f.call("cell","repl.execute",json!({"target":{"type":"create","runtime":"python"},"cells":[{"id":"a","code":"await runtime.exec('touch helper_started; sleep 1; touch should_not_exist')"}],"completion":{"mode":"yield","wait_ms":100}})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !f.dir.path().join("helper_started").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.core.cancel("cell").unwrap();
    let end=f.call("collect","repl.collect",json!({"session":result["session"],"execution_id":result["execution_id"],"wait_ms":2000})).await.unwrap();
    assert_ne!(end["state"], "running");
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(!f.dir.path().join("should_not_exist").exists());
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancellation_after_exec_yield_stops_process() {
    let f = Fixture::new();
    let start=f.call("start","execution.exec",json!({"command":{"type":"shell","script":"sleep 30"},"completion":{"mode":"yield","wait_ms":250}})).await.unwrap();
    f.core.cancel("start").unwrap();
    let result = f
        .call(
            "collect",
            "execution.interact",
            json!({"session_id":start["session_id"],"input":{"type":"none"}}),
        )
        .await
        .unwrap();
    assert_eq!(result["state"], "finished");
    assert_eq!(result["reason"], "terminated");
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_interpreter_and_capacity_fail_without_leaking_artifacts() {
    let f = Fixture::configured(|c| {
        c.python = "/nonexistent/python-for-test".into();
        c.max_processes = 1;
    });
    assert_eq!(
        f.call(
            "python",
            "repl.execute",
            json!({"target":{"type":"create","runtime":"python"},"cells":[{"id":"a","code":"1"}]})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::InterpreterUnavailable
    );
    f.call("start","execution.exec",json!({"command":{"type":"shell","script":"sleep 30"},"completion":{"mode":"yield","wait_ms":250}})).await.unwrap();
    let runtime = f
        .dir
        .path()
        .join(".execution-artifacts")
        .join(format!("runtime-{}", f.core.generation()));
    let before = std::fs::read_dir(&runtime).unwrap().count();
    assert_eq!(
        f.call(
            "limit",
            "execution.exec",
            json!({"command":{"type":"shell","script":"true"},"output":{"retain_full_output":true}})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(before, std::fs::read_dir(&runtime).unwrap().count());
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn repl_output_is_bounded_and_helpers_read_patch_and_emit_json() {
    let f = Fixture::configured(|c| c.max_repl_output_bytes = 2000);
    let result = f
        .repl(
            "large",
            json!({"type":"create","runtime":"node"}),
            json!([{"id":"a","code":"console.log('x'.repeat(100000))"}]),
        )
        .await;
    assert_eq!(result["state"], "succeeded");
    assert_eq!(result["events_truncated"], true);
    let helper=f.repl("helpers",existing(&result),json!([{"id":"b","code":"await runtime.write('file', 'old\\n'); await runtime.applyPatch('*** Begin Patch\\n*** Update File: file\\n@@\\n-old\\n+new\\n*** End Patch'); var file = await runtime.read('file'); runtime.emitJson({text:file.text});"}])).await;
    assert_eq!(helper["state"], "succeeded", "{helper}");
    assert!(
        helper["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "json" && e["data"]["text"] == "new\n"),
        "{helper}"
    );
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn dropping_idle_runtime_kills_interpreters() {
    let f = Fixture::new();
    let result = f
        .repl(
            "node",
            json!({"type":"create","runtime":"node"}),
            json!([{"id":"pid","code":"process.pid"}]),
        )
        .await;
    let pid: u32 = output(&result).trim().parse().unwrap();
    drop(f.core);
    #[cfg(unix)]
    tokio::time::timeout(Duration::from_secs(3), async {
        while unsafe { libc::kill(pid as i32, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn local_modules_async_rejection_and_unicode_cells_work() {
    let f = Fixture::new();
    std::fs::write(f.dir.path().join("local_module.py"), "value = 37\n").unwrap();
    std::fs::write(
        f.dir.path().join("local_module.cjs"),
        "module.exports = {value: 37};\n",
    )
    .unwrap();
    let py=f.repl("python",json!({"type":"create","runtime":"python"}),json!([{"id":"module","code":"import local_module\nprint(local_module.value)\nprint('हेलो 🌍')"}])).await;
    assert_eq!(py["state"], "succeeded", "{py}");
    assert!(output(&py).contains("37"));
    assert!(output(&py).contains("हेलो 🌍"));
    let node=f.repl("node",json!({"type":"create","runtime":"node"}),json!([{"id":"module","code":"console.log(require('./local_module.cjs').value); console.log('हेलो 🌍');"}])).await;
    assert_eq!(node["state"], "succeeded", "{node}");
    assert!(output(&node).contains("37"));
    assert!(output(&node).contains("हेलो 🌍"));
    let failure = f
        .repl(
            "rejection",
            existing(&node),
            json!([{"id":"bad","code":"await Promise.reject(Error('async failure'))"}]),
        )
        .await;
    assert_eq!(failure["state"], "failed", "{failure}");
    let next = f
        .repl("after", existing(&node), json!([{"id":"ok","code":"21*2"}]))
        .await;
    assert!(output(&next).contains("42"), "{next}");
    f.core.shutdown().await.unwrap();
}

#[tokio::test]
async fn dropping_runtime_kills_yielded_commands() {
    let f = Fixture::new();
    let result=f.call("pid","execution.exec",json!({"command":{"type":"shell","script":"echo $$; sleep 30"},"completion":{"mode":"yield","wait_ms":250}})).await.unwrap();
    let pid: u32 = result["output"].as_str().unwrap().trim().parse().unwrap();
    drop(f.core);
    #[cfg(unix)]
    tokio::time::timeout(Duration::from_secs(3), async {
        while unsafe { libc::kill(pid as i32, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
