# Process execution core

Transport-independent Rust library for native tool execution. It owns process
sessions, interpreter sessions, output, request receipts, and cleanup. The
daemon exposes each operation directly through the gateway; tool workers do
not need a database or a read/modify/write sequence.

## Operations and adapters

| Operation | Intended adapter | Behavior |
| --- | --- | --- |
| `execution.exec` | Codex `exec_command`; Pi bash | Shell/direct command, pipes or PTY, yield or await completion, bounded head/tail output, optional output artifact. |
| `execution.interact` | Codex `write_stdin` | Write input or interrupt and collect new output in one call. Empty input polls. |
| `execution.close` | Lifecycle control | Terminate the process tree and close its session. |
| `filesystem.read` | Pi read; Codex view_image | Text with line paging/truncation metadata, binary base64, or validated inline image bytes and dimensions. |
| `filesystem.write` | Pi write | Overwrite or conditional atomic replacement; optionally create parents. |
| `filesystem.patch` | Pi edit; Codex apply_patch | Original-content text replacements or Codex patch grammar, conflict checks, bounded diff and explicit partial-failure receipts. |
| `repl.execute` | Python/Node REPL | Create or reuse a session; execute ordered cells; yield or await completion. |
| `repl.collect` | REPL continuation | Collect pending events/status without executing cells again. |
| `repl.interrupt` | REPL control | Interrupt active execution and its native helpers; kill interpreter if it does not settle within the configured grace. |
| `repl.reset` | REPL control | Close old interpreter and create a fresh session with a new handle. |
| `repl.close` | REPL control | Stop interpreter, descendants, and its outstanding helpers. |

The public Rust types are in `src/api.rs`. `Operation` uses an `operation` tag
and `params` content. `execute(Request)` returns `Result<serde_json::Value>`;
failures have a stable `code` and message. Tool adapters format this native result
into Pi/Codex model messages, apply model-specific token budgets, and upload image
bytes when a URL is needed. The core does not store provider credentials or
perform image hosting.

Pi bash uses `completion: {mode: "finished", timeout_ms: ...}`, `tty: false`,
`output.strategy: "tail"`, and optionally `retain_full_output: true`. Codex exec
uses `completion: {mode: "yield", wait_ms: ...}` and `head_tail`. A finished exec
result has `session_id: null`; a yielded one has a UUID session ID.

## Minimal usage

Create the core inside a Tokio runtime. Paths in `Config` must be absolute.

```rust,no_run
use process_execution_core::{Config, Operation, ProcessExecutionCore, Request};
use serde_json::json;

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let mut config = Config::new(std::env::current_dir()?);
config.retention.unread_results = std::time::Duration::from_secs(24 * 60 * 60);
let core = ProcessExecutionCore::new(config)?;
let operation: Operation = serde_json::from_value(json!({
    "operation": "execution.exec",
    "params": {
        "command": {"type": "shell", "script": "printf hello", "login": false},
        "cwd": std::env::current_dir()?,
        "env": {},
        "completion": {"mode": "finished", "timeout_ms": 10_000}
    }
}))?;
let result = core.execute(Request {
    request_id: "tool-call-1".into(), operation,
}).await?;
println!("{result}");
// After a transport has durably delivered the result:
core.mark_delivered("tool-call-1")?;
core.shutdown().await?;
# Ok(())
# }
```

There is one runtime-wide registry of requests, processes, and interpreters.
Exec, read, write, and patch requests require an existing absolute `cwd`; file
paths may be relative to it. Commands supply their own environment overrides
and may choose their shell and login behavior. New REPLs supply `cwd` and `env`
in their `target`; subsequent cells use the persistent interpreter state.
`Config.cwd` initializes the native backend; it is not an implicit request cwd.
Pipes have closed stdin; use `tty: true` for interactive programs. Empty input
polls for at least 5 seconds (up to the configured maximum); nonempty input polls
for at least 250 ms. Process output is combined stdout/stderr in arrival order.
The core uses byte and line budgets; token formatting belongs to adapters.

## Request ownership and retries

- Each request ID is unique across the runtime; UUIDs are recommended. The same ID and input join/replay the
  original operation. Changed input returns `idempotency_conflict`.
- Acceptance reserves receipt capacity **before** dispatch. Capacity failure
  leaves the operation unstarted. Dropping an HTTP/request future only stops
  waiting; accepted work continues and stores its result.
- `mark_delivered(request_id)` is an embedding transport hook indicating durable delivery. Until then,
  its receipt remains replayable. After delivered-receipt retention expires,
  a small tombstone returns `result_expired`; that ID never executes again.
- `cancel(request_id)` is explicit cancellation. It also stops a yielded
  exec or a running/yielded cell execution. Cancelling a collect operation does
  not cancel the cell. Filesystem mutations already committing may finish;
  cancellation is not rollback.
- Per-process interactions and per-REPL executions serialize. Independent
  processes and interpreter sessions can run concurrently. Concurrent REPL
  submissions enter a FIFO lock in runtime admission order; callers that need a
  particular dependency order should submit the preceding operation first.
- Replay receipts are in memory. A runtime restart cannot restore variables,
  processes, or request receipts. Exec and REPL IDs are fresh UUIDs that are never
  reused, so stale handles cannot target replacement sessions. The daemon also
  checks runtime generation before dispatching a request across a restart.

## REPL semantics

Python uses IPython's async evaluator with a persistent namespace and asyncio
loop. Node uses `node:repl`, preserving declarations and supporting top-level
await. Both run in supervised subprocesses with a separate authenticated
loopback control socket. User stdout cannot masquerade as control frames.
This protocol separation is not a sandbox: cells execute with the host user's
filesystem, network, and process permissions.

`repl.execute` accepts `target: {type: "create", runtime: "python" | "node", cwd: "/absolute/directory", env: {...}}` or
`{type: "existing", session: <returned handle>}`, `cells: [{id, code}, ...]`,
`stop_on_error` (default true), and `completion`. Every call returns a session
UUID, execution ID, cell statuses, overall state, state integrity, events, and
an explicit overflow flag. Common event kinds are `stdout`, `stderr`, `result`,
`json`, `image`, and `error`.

A normal exception retains prior variables and partial effects. Remaining cells
are skipped by default. Interrupt may retain partial state or lose the whole
interpreter if it must be killed; inspect `state_integrity`. Reset never replays
old cells. Queued cells on a lost interpreter fail without migrating to its
replacement. Late async output retains its originating execution ID; direct
file-descriptor output is unattributed background output. Later collection can
return those events. Expired execution output is discarded.

### Built-in helpers

Python:

```python
await runtime.write("hello.txt", "hello\n")
file = await runtime.read("hello.txt")
result = await runtime.exec("cat hello.txt", timeout_ms=5000)
await runtime.apply_patch("*** Begin Patch\n*** Add File: example.txt\n+text\n*** End Patch")
runtime.emit_json({"text": file["text"], "exit_code": result["exit_code"]})
await runtime.display_image("photo.png")
```

Node equivalents are `runtime.write`, `read`, `exec`, `applyPatch`, `emitJson`,
and `displayImage`. `runtime.call(operation, params)` provides direct access to
exec/interact/read/write/patch; lifecycle operations are controlled by the host.
Helpers use the same native implementation, limits, and request ledger. Their
IDs derive from the originating execution; they cannot accidentally replay a
cell. Helpers default to the interpreter's initial cwd and environment, with per-call
overrides. Reset creates a new interpreter UUID using that same launch context.
Native helpers invoked by a cancelled cell are also cancelled; side effects
that already occurred remain.

Images are validated before publication. Python supports IPython PNG/JPEG rich
display; both runtimes support the image helper. Arbitrary HTML/JavaScript rich
output is not rendered. Python `input()` is disabled; use an exec PTY for input.
Local modules resolve from the interpreter's cwd.

## Lifetimes and configurable cleanup

All elapsed-time cleanup settings are in `Config.retention`:

| Setting | Default | Applies to |
| --- | --- | --- |
| `unread_results` | 24 hours | Finished exec records and completed REPL event buffers from completion; closed REPL records from interpreter exit. |
| `delivered_receipts` | 24 hours | Replay payloads, from durable delivery; small tombstones survive. |
| `artifacts` | 24 hours | Completed full-output files, from completion. |
| `sweep_interval` | 30 seconds | Cleanup scan cadence; expiration occurs on the next scan. |

Zero retention means expiration at the next sweep. Sweep interval must be
positive. `sweep()` is also available for deterministic maintenance/testing.
Artifacts report an expiry timestamp after completion; active artifacts report
null and `complete: false`. Artifacts belong to the runtime and are removed by
runtime shutdown/drop, even before their TTL.

**Live exec and idle REPL sessions have no automatic idle timeout or task lease.**
Use `execution.close`, `repl.close`, `request.cancel`, or an explicit execution
completion timeout to stop work. A finished cell leaves its interpreter available
for the next turn. Gateway disconnects do not close the core.

`shutdown` rejects new work, terminates owned processes/interpreters, waits for
accepted requests to settle, and removes runtime-owned artifacts. It preserves
receipts for replay while the core still exists, and never removes user-created
files. Dropping an idle core also initiates cleanup but does not await it.
Closed REPL records and finished exec records expire using `unread_results`;
live interpreters retain their variables even when their old output expires.

The public API has no scope setup, renewal, release, or request acknowledgement
operation. `mark_delivered` is used internally by the daemon after `result_ack`
and by the REPL helper transport. It is not a remotely callable operation.

## Limits and dependencies

`Config` exposes global process/REPL/request counts, request/result sizes, receipt
memory reservation, process and REPL output sizes, image pixels, cell count,
artifact bytes, wait bounds, startup timeout, and interrupt/termination/drain
grace periods. Defaults include:

- 5 MiB file source/write maximum; larger files return `resource_limit`, even
  when requesting only a line range. Config can lower this maximum.
- 40 million decoded image pixels. PNG, JPEG, GIF, WebP and BMP readers;
  optional thumbnailing, BMP converted to PNG, inline base64 image results.
- 1 MiB retained process preview; 7 MiB pending event bytes per REPL; explicit
  truncation when those bounds are reached. Process preview keeps head and tail.
- 128 MiB per full-output artifact. `complete: false` reports truncation or
  incomplete capture. Filesystem read's 5 MiB bound still applies to artifacts.
- 8 MiB request and result limits; 64 MiB receipt payload/reservation budget per
  runtime. At the defaults, at most eight maximum-sized results can be reserved
  concurrently. The request-count limit is an additional bound.
- 64 live processes and 8 live interpreters across the runtime.
  Counts are bounded instead of evicting live work silently.
- 100,000 request identities, including tombstones. Delivery retention frees
  payload bytes, not identities. Reaching the identity limit rejects new work;
  a fresh runtime is required to reset that ledger.

Python and Node paths are configurable and checked lazily on REPL creation.
Python requires IPython (`python -m pip install 'ipython>=8,<10'`). The Node REPL
targets Node.js 26. There is no Node package installation.
This implementation was exercised on macOS with
Python 3.12.8 / IPython 9.8.0 and Node 26.8.2; other host/runtime versions need
platform verification. Unix process groups and Windows Job/ConPTY backends are
included; the Windows backend has not been exercised in this change.

The copied native engine retains its regression suite and Codex patch-parser
license in `src/native/filesystem/CODEX-LICENSE`. Its hidden `native` module is
an implementation/testing detail; new adapters should use the facade.

## Verification

From the repository root:

```sh
cargo test --manifest-path execution/Cargo.toml
cargo clippy --manifest-path execution/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path execution/Cargo.toml --check
```

Tests launch real shell processes, PTYs, Python, and Node in temporary folders.
They cover patch compatibility, file conflicts, image validation, state and
module persistence, helper calls, duplicate delivery, queueing, output bounds,
cancellation, interruption, reset, global limits, explicit launch contexts, configurable expiry,
artifacts, process descendants, and cleanup. No gateway or provider account is
required for these native end-to-end tests.
