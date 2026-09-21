//! Test-only stdio adapter used by the gateway integration suite. This is not a
//! production daemon: registration, credential storage, and durable delivery
//! are implemented in process-execution-daemon.
use process_execution_core::{Config, ProcessExecutionCore, Request};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    sync::{Arc, Mutex},
};

fn emit(output: &Mutex<std::io::Stdout>, value: Value) {
    let mut out = output.lock().unwrap();
    writeln!(out, "{value}").unwrap();
    out.flush().unwrap();
}
#[tokio::main]
async fn main() {
    let cwd = std::env::args()
        .nth(1)
        .expect("absolute fixture cwd required");
    let core = ProcessExecutionCore::new(Config::new(cwd)).unwrap();
    let output = Arc::new(Mutex::new(std::io::stdout()));
    emit(
        &output,
        json!({"type":"ready","generation":core.generation()}),
    );
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            if sender.send(value).is_err() {
                break;
            }
        }
    });
    while let Some(message) = receiver.recv().await {
        let core = core.clone();
        let output = output.clone();
        tokio::spawn(async move {
            let id = message["requestId"].as_str().unwrap().to_owned();
            let operation = message["operation"]["operation"].as_str().unwrap();
            let result = match operation {
                "request.cancel" => core
                    .cancel(
                        message["operation"]["params"]["request_id"]
                            .as_str()
                            .unwrap(),
                    )
                    .map(|()| json!({"state":"cancelled"})),
                "runtime.capabilities" => Ok(core.capabilities()),
                _ => {
                    let request: Request = serde_json::from_value(
                        json!({"request_id":id,"operation":message["operation"]}),
                    )
                    .unwrap();
                    core.execute(request).await
                }
            };
            let outcome = match result {
                Ok(result) => json!({"status":"ok","result":result}),
                Err(error) => {
                    json!({"status":"error","error":{"code":error.code,"message":error.message,"uncertain":false}})
                }
            };
            emit(&output, json!({"requestId":id,"outcome":outcome}));
        });
    }
    core.shutdown().await.unwrap();
}
