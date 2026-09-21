use crate::{Command, PatchInput};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub operation: Operation,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", content = "params", rename_all = "snake_case")]
pub enum Operation {
    #[serde(rename = "execution.exec")]
    Exec(ExecRequest),
    #[serde(rename = "execution.interact")]
    Interact(InteractRequest),
    #[serde(rename = "execution.close")]
    CloseExec { session_id: Uuid },
    #[serde(rename = "filesystem.read")]
    Read(ReadRequest),
    #[serde(rename = "filesystem.write")]
    Write(WriteRequest),
    #[serde(rename = "filesystem.patch")]
    Patch { cwd: PathBuf, patch: PatchInput },
    #[serde(rename = "repl.execute")]
    ReplExecute(ReplExecuteRequest),
    #[serde(rename = "repl.collect")]
    ReplCollect(ReplCollectRequest),
    #[serde(rename = "repl.interrupt")]
    ReplInterrupt { session: Uuid },
    #[serde(rename = "repl.reset")]
    ReplReset { session: Uuid },
    #[serde(rename = "repl.close")]
    ReplClose { session: Uuid },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Completion {
    Yield { wait_ms: u64 },
    Finished { timeout_ms: Option<u64> },
}
impl Default for Completion {
    fn default() -> Self {
        Self::Yield { wait_ms: 10000 }
    }
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputStrategy {
    Head,
    Tail,
    #[default]
    HeadTail,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputOptions {
    #[serde(default)]
    pub strategy: OutputStrategy,
    pub max_bytes: Option<usize>,
    pub max_lines: Option<usize>,
    #[serde(default)]
    pub retain_full_output: bool,
}
impl Default for OutputOptions {
    fn default() -> Self {
        Self {
            strategy: OutputStrategy::HeadTail,
            max_bytes: Some(40000),
            max_lines: None,
            retain_full_output: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecRequest {
    pub command: Command,
    pub cwd: PathBuf,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub tty: bool,
    #[serde(default)]
    pub completion: Completion,
    #[serde(default)]
    pub output: OutputOptions,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "text", rename_all = "snake_case")]
pub enum Input {
    None,
    Text(String),
    Interrupt,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractRequest {
    pub session_id: Uuid,
    pub input: Input,
    pub wait_ms: Option<u64>,
    #[serde(default)]
    pub output: OutputOptions,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadMode {
    #[default]
    Auto,
    Text,
    Image,
    Bytes,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadRequest {
    pub path: PathBuf,
    pub cwd: PathBuf,
    #[serde(default)]
    pub mode: ReadMode,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub max_bytes: Option<usize>,
    pub max_lines: Option<usize>,
    /// Optional aspect-preserving thumbnail. Omission preserves original bytes.
    pub image_max_dimension: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum FileContent {
    Text(String),
    Base64(String),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteRequest {
    pub path: PathBuf,
    pub cwd: PathBuf,
    pub content: FileContent,
    #[serde(default = "yes")]
    pub create_parents: bool,
    pub precondition: Option<crate::native::FilePrecondition>,
}
fn yes() -> bool {
    true
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Python,
    Node,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReplTarget {
    Create {
        runtime: Language,
        cwd: PathBuf,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Existing {
        session: Uuid,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    pub id: String,
    pub code: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplExecuteRequest {
    pub target: ReplTarget,
    pub cells: Vec<Cell>,
    #[serde(default = "yes")]
    pub stop_on_error: bool,
    #[serde(default)]
    pub completion: Completion,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplCollectRequest {
    pub session: Uuid,
    pub execution_id: Uuid,
    pub wait_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecResult {
    pub session_id: Option<Uuid>,
    pub state: String,
    pub exit_code: Option<i64>,
    pub signal: Option<String>,
    pub reason: Option<String>,
    pub output: String,
    pub original_bytes: u64,
    pub output_truncated: bool,
    pub output_incomplete: bool,
    pub wall_time_seconds: f64,
    pub artifact: Option<Artifact>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub id: Uuid,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub complete: bool,
    pub expires_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplResult {
    pub session: Uuid,
    pub execution_id: Uuid,
    pub state: String,
    pub state_integrity: String,
    pub events: Vec<serde_json::Value>,
    pub events_truncated: bool,
    pub cells: Vec<CellStatus>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellStatus {
    pub id: String,
    pub status: String,
}
