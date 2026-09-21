use crate::Result;
use process_execution_core::{Operation, ProcessExecutionCore, Request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;
pub const MAX_RESULT: usize = 8 * 1024 * 1024;
pub const MAX_FRAME: usize = MAX_RESULT + 128 * 1024;
pub const OPERATIONS: &[&str] = &[
    "request.cancel",
    "runtime.capabilities",
    "execution.exec",
    "execution.interact",
    "execution.close",
    "filesystem.read",
    "filesystem.write",
    "filesystem.patch",
    "repl.execute",
    "repl.collect",
    "repl.interrupt",
    "repl.reset",
    "repl.close",
];
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Incoming {
    #[serde(rename = "type")]
    pub kind: String,
    pub protocol_version: u8,
    pub dispatch_id: Uuid,
    pub request_id: String,
    pub request_hash: String,
    pub runtime_generation: Uuid,
    pub operation: Value,
    pub routing_envelope: String,
}
pub enum Action {
    Cancel(String),
    Capabilities,
    Native(Box<Operation>),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    request_id: String,
}
pub fn identity(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:@-".contains(&c))
}
pub fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn hash(value: &Value) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json_canonicalizer::to_vec(value)?)
    ))
}
impl Incoming {
    pub fn key(&self) -> String {
        format!("{}:{}", self.runtime_generation, self.request_id)
    }
    pub fn action(&self) -> Result<Action> {
        if self.kind != "request"
            || self.protocol_version != 1
            || !identity(&self.request_id)
            || !digest(&self.request_hash)
            || self.routing_envelope.len() > 32768
            || self.routing_envelope.is_empty()
        {
            return Err("invalid request envelope".into());
        }
        let op = self
            .operation
            .as_object()
            .ok_or("operation must be an object")?;
        if op.len() != 2 {
            return Err("operation requires only operation and params".into());
        }
        let name = op
            .get("operation")
            .and_then(Value::as_str)
            .ok_or("missing operation")?;
        let params = op
            .get("params")
            .filter(|v| v.is_object())
            .ok_or("params must be an object")?
            .clone();
        let empty = || -> Result<()> {
            if params.as_object().unwrap().is_empty() {
                Ok(())
            } else {
                Err("operation takes no params".into())
            }
        };
        Ok(match name {
            "runtime.capabilities" => {
                empty()?;
                Action::Capabilities
            }
            "request.cancel" => {
                let id = serde_json::from_value::<Target>(params)?.request_id;
                if !identity(&id) {
                    return Err("invalid target request_id".into());
                }
                Action::Cancel(id)
            }
            _ => Action::Native(Box::new(serde_json::from_value(self.operation.clone())?)),
        })
    }
    pub fn reply(&self, error: Option<(&str, &str, bool, bool)>) -> Value {
        let mut reply = json!({"type":"accepted","dispatchId":self.dispatch_id,"requestId":self.request_id,"requestHash":self.request_hash,"runtimeGeneration":self.runtime_generation});
        if let Some((code, message, retryable, uncertain)) = error {
            reply["type"] = json!("rejected");
            reply["error"] =
                json!({"code":code,"message":message,"retryable":retryable,"uncertain":uncertain});
        }
        reply
    }
}
pub async fn execute(core: &ProcessExecutionCore, req: &Incoming, action: Action) -> Value {
    let result = match action {
        Action::Capabilities => Ok(core.capabilities()),
        Action::Cancel(id) => core.cancel(&id).map(|()| json!({"state":"cancelled"})),
        Action::Native(operation) => {
            core.execute(Request {
                request_id: req.request_id.clone(),
                operation: *operation,
            })
            .await
        }
    };
    let result = match result {
        Ok(value) => json!({"status":"ok","result":value}),
        Err(e) => {
            let uncertain = matches!(
                e.code,
                process_execution_core::ErrorCode::Io
                    | process_execution_core::ErrorCode::Unavailable
                    | process_execution_core::ErrorCode::ResourceLimit
                    | process_execution_core::ErrorCode::Cancelled
            );
            json!({"status":"error","error":{"code":e.code,"message":e.message.chars().take(4096).collect::<String>(),"uncertain":uncertain}})
        }
    };
    if serde_json::to_vec(&result).map_or(true, |v| v.len() > MAX_RESULT) {
        error(
            "RESULT_TOO_LARGE",
            "Native result exceeded the transport limit; effects may have occurred.",
            true,
        )
    } else {
        result
    }
}
pub fn error(code: &str, message: &str, uncertain: bool) -> Value {
    json!({"status":"error","error":{"code":code,"message":message,"uncertain":uncertain}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_json_matches_javascript_numbers_and_utf16_key_order() {
        let value = json!({"z":-0.0,"a":1.0,"b":1e-7,"c":1e21,"d":9007199254740993u64,"\u{e000}":1,"\u{10000}":2});
        assert_eq!(
            serde_json_canonicalizer::to_string(&value).unwrap(),
            "{\"a\":1,\"b\":1e-7,\"c\":1e+21,\"d\":9007199254740992,\"z\":0,\"𐀀\":2,\"\":1}"
        );
    }
}
