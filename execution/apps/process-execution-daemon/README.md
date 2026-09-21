# Process execution daemon

Native daemon for the Cloudflare execution gateway v1. This binary embeds
[`process-execution-core`](../../packages/process-execution-core/README.md), connects
outbound over an authenticated WebSocket, and owns a durable local request/result
journal. No inbound port or tunnel is needed.

The new binary is **`process-execution-daemon`**. Its configuration, service names,
and gateway protocol are separate from the legacy `process-execution-host-daemon`.
Nothing here migrates or replaces the installed legacy daemon automatically.

## Build and register

From the repository root:

```sh
cargo build --release --manifest-path execution/Cargo.toml -p process-execution-daemon
install -m 755 execution/target/release/process-execution-daemon "$HOME/.local/bin/process-execution-daemon"
```

The gateway must first be deployed with an HTTPS route. Registration uses its
existing trusted-backend API. Read the backend token from stdin (for example, a
private token file); it is used only for registration and is **never saved**:

```sh
process-execution-daemon register \
  --gateway-url https://YOUR-GATEWAY-HOST \
  --user-id YOUR_USER_ID \
  --name "My Mac" < /path/to/private-backend-token
process-execution-daemon connect
process-execution-daemon status
```

The backend token is privileged across users. End-user distribution should have
your application backend pre-register the machine and issue a machine token; users
then use `configure` below. This daemon does not implement a browser login or a
single-use registration-code flow.

Registration persists a generated machine UUID **before** making HTTP calls.
Identical retries therefore reuse the registration even if a response was lost.
An optional `--machine-id UUID` pins the initial ID. Retry with the original name
and user; renaming an existing registration is a gateway management operation.

To use an already-issued machine credential:

```sh
process-execution-daemon configure \
  --gateway-url https://YOUR-GATEWAY-HOST \
  --user-id YOUR_USER_ID --machine-id MACHINE_UUID < /path/to/private-machine-token
process-execution-daemon connect
```

A state directory belongs permanently to its gateway/user/machine identity.
Changing owner requires a separate directory. Both commands must run while its
daemon is stopped. Token input is a single line; credentials are never accepted
as command-line arguments or printed by status.

## Commands and output

| Command | Behavior |
| --- | --- |
| `register` | Register/idempotently recover enrollment and save a machine token |
| `configure` | Save an existing machine token for this installation |
| `connect [--config PATH]` | Install/start a user login service; optionally save the supplied config |
| `run [--config PATH]` | Run in foreground; Ctrl-C/SIGTERM shuts down native sessions |
| `disconnect` | Request graceful shutdown and disable login startup; preserve credentials and results |
| `restart` | Stop native sessions and start a new core generation |
| `status` | Show connection, machine, gateway and counts needing attention |
| `outbox` | Show quarantined request/delivery IDs and reasons; no result/file contents |
| `outbox --retry DELIVERY_ID` | Requeue a retained failed delivery, without rerunning its operation |
| `outbox --discard DELIVERY_ID` | Permanently clear a quarantined result payload, keeping its identity tombstone |
| `update` | Use the saved release-manifest URL |
| `update --manifest-url HTTPS_URL` | Verify/install a release and save its manifest URL for future updates |
| `update --from PATH --sha256 HEX` | Verify/install a local build |
| `version` / `--version` | Human-readable version information |

All commands accept `--state-dir PATH`. Default state is the user's local app data
folder under `managed-agents-execution` (on macOS,
`~/Library/Application Support/managed-agents-execution`).

Example status:

```text
Daemon: connected
Machine: 10000000-0000-4000-8000-000000000003
Gateway: https://gateway.example.com/
Work: 1 running · 0 awaiting delivery · 0 need attention
```

Successful command output is concise text. Errors go to stderr with exit code 2.
A running daemon prints connection transitions and permanent delivery failures;
it does not log commands, file contents, result bodies or tokens. Service managers'
normal output is suppressed. On macOS stderr is in `STATE_DIR/logs/daemon.log`;
on Linux use the corresponding systemd user journal.

Services use macOS LaunchAgents, Linux systemd user units, or Windows scheduled
login tasks, following the earlier daemon's service approach. A hash of the state
path identifies the service so separate installations cannot stop one another.
PATH is captured when installing the service; Python/Node paths can also be set
explicitly. macOS disconnect removes its LaunchAgent file so login does not
re-enable it. Linux disables the unit; Windows disables the task.

The runtime retries transient network failures itself. Fatal authentication errors
and connection replacement stop it instead of competing with a newer connection.
macOS also requests restart after crash signals; Linux uses restart-on-failure
with exit code 2 excluded. Windows login-task crash supervision is not provided.

## Gateway connection and credential renewal

The daemon connects to `GET /v1/connect`, completes `welcome` / `hello` / `ready`,
and advertises all supported core/control operations. Text heartbeats use the
DO's hibernation-compatible `execution:ping` / `execution:pong` pair. Missing
heartbeats trigger reconnect with exponential backoff and jitter.

The core survives a transport reconnect, preserving exec and REPL sessions.
A daemon/core restart creates a new runtime generation. Requests addressed to
another runtime generation are rejected without execution.

Machine tokens renew at roughly 80% of their remaining lifetime through the new
`POST /v1/machine-token/refresh` endpoint. Renewal requires a currently valid,
enabled, unrevoked machine token and preserves its user, machine and credential
version. The new token is saved atomically before reconnecting. The daemon never
needs the backend token for routine renewal. An expired or revoked credential
requires backend reissuance through `register` or `configure`.

TLS is required. `register` and `configure` support
`--allow-insecure-loopback` for local tests only; it persists that setting. URLs
with embedded credentials, paths, queries or fragments are rejected, and HTTP
redirects are disabled.

## Request and result ownership

1. Validate envelope/operation shape and runtime generation.
2. Reserve a journal row and worst-case result capacity in SQLite, using WAL and
   `synchronous=FULL`, **before accepting or dispatching**.
3. Reply `accepted` and execute asynchronously. Semantic core errors are completed
   tool outcomes. Delivery and other requests continue while work runs.
4. Persist the exact outcome and canonical result/delivery hashes before sending it.
5. Wake delivery immediately after persistence. Start the acknowledgement timeout
   after the complete payload has flushed, then retry with the same delivery ID
   and saved return ticket until a matching
   `result_ack` confirms durable receiver admission.
6. Mark delivered and notify the core through its internal `mark_delivered` hook.
   Retain a replay window, then replace the payload with an identity tombstone.

The request key includes runtime generation and request ID.
Same-key retries with identical envelope/operation fingerprints join/replay;
changed input fails. The daemon journal also deduplicates control calls.
Rust result serialization uses JavaScript-compatible canonical JSON, including
number formatting and UTF-16 key ordering, so hashes agree with the gateway.

A process crash can happen between a side effect and recording its result.
Previously active journal rows become `DAEMON_RESTARTED` outcomes with
`uncertain:true`; the daemon **does not rerun them**. Completed results are
redelivered with their original generation and ticket after restart. Abrupt death
may leave native work whose final effects are unknown; callers must reconcile
uncertain work before deliberately issuing replacement operations. Live exec/REPL
sessions themselves do not survive a core restart.

Permanent nacks and the configurable delivery horizon quarantine the result,
retaining its payload for inspection/recovery. This consumes the outbox budget;
capacity rejection happens before new execution. `outbox --retry` retries delivery
only. It cannot repair an expired signed return ticket; a same-identity resubmission
with fresh authorization can replace the ticket while that core generation remains
available. Recovery beyond the signed ticket horizon needs backend intervention.
There is no automatic deletion of undelivered/quarantined results. After reconciling
a permanently failed delivery, `outbox --discard DELIVERY_ID` explicitly clears
its payload while retaining the no-reexecution tombstone.

Delivered payloads expire after the configured retention period. Current-runtime
tombstones remain to prevent the same request ID from executing again; expired
older-runtime tombstones can be removed because the runtime-generation fence
prevents replay. Journal capacity is bounded by both request count and reserved
result bytes. These are logical limits, not a filesystem disk-space reservation;
if result persistence fails, the daemon stops and keeps the request uncertain.

## Native operation mappings

Native `execution.*`, `filesystem.*` and `repl.*` operations pass directly to
`ProcessExecutionCore::execute`, preserving its schemas/results. This covers Pi
bash/read/write/edit, Codex exec/stdin/apply_patch/view_image and persistent REPLs.
Tool-specific model-message formatting and hosted image uploads remain in tool
adapters; the daemon returns native image bytes.

The daemon advertises 13 operations: the eleven native operations above plus:

| Operation | `params` | Successful result |
| --- | --- | --- |
| `request.cancel` | `{request_id}` | `{state:"cancelled"}` |
| `runtime.capabilities` | `{}` | Core capabilities object |

Requests have no scope field. The runtime owns a global process registry, REPL
registry, and request ledger. Example request envelope (identity/hash/ticket
placeholders must be replaced by the gateway):

```json
{
  "type": "request",
  "protocolVersion": 1,
  "dispatchId": "<dispatch UUID>",
  "requestId": "<stable request UUID>",
  "requestHash": "<canonical request SHA-256>",
  "runtimeGeneration": "<current runtime UUID>",
  "operation": {
    "operation": "execution.exec",
    "params": {
      "command": {"type": "shell", "script": "printf hello"},
      "cwd": "/absolute/working/directory",
      "env": {},
      "completion": {"mode": "yield", "wait_ms": 1000}
    }
  },
  "returnTicket": "<gateway-issued return ticket>"
}
```

Exec, read, write, and patch require an existing absolute `cwd`. Commands take
per-request environment overrides. REPL creation takes
`target:{type:"create",runtime:"python"|"node",cwd,env}`; reuse takes
`target:{type:"existing",session:"<UUID>"}`. Exec `session_id` and REPL `session`
are UUID strings. Reset returns a new UUID and preserves the original REPL launch
context. All native parameter and result types are documented in the
[core API](../../packages/process-execution-core/src/api.rs).

There are no task leases or scope lifecycle operations. Processes survive gateway
reconnects; explicit close/cancel, a requested execution timeout, or daemon shutdown
stops them. Completed output and delivered receipt payloads have bounded retention.
`result_ack` remains a transport message and automatically marks the native receipt
delivered; no `request.acknowledge` RPC is exposed.

All replies use the outcome envelope `{status:"ok",result}` or
`{status:"error",error}` inside a persisted `result` delivery. Native operations
run with this OS user's permissions; the daemon does not introduce an OS sandbox.

**Migration status:** this is the first pass of a breaking, unpublished API change.
The gateway protocol package, gateway/user-machine workers, and harness adapters
still need their separate migration passes before they can use this daemon.
Historical benchmark outputs describe the previous API.

## Configuration

JSON at `STATE_DIR/config.json`; unknown fields and invalid limits fail startup.
`connect --config PATH` copies a validated config into the state directory so
future restarts and updates keep using it. `run --config PATH` overrides it only
for that foreground invocation. Configuration defaults:

| Field | Default |
| --- | --- |
| `cwd` | Native backend base directory, default user home; requests still supply their own absolute cwd |
| `python`, `node` | `python3`, `node` |
| `allow_insecure_loopback` | false |
| `update_manifest_url` | null; no new release feed has been published yet |
| `max_processes`, `max_repls` | 64, 8 globally |
| `max_active_requests` | 16 |
| `max_journal_requests` | 100000 |
| `max_outbox_bytes` | 536870912 (512 MiB) |
| `delivered_retention_seconds` | 86400 |
| `delivery_horizon_seconds` | 86400 |
| `core_unread_retention_seconds` | 86400 |
| `core_receipt_retention_seconds` | 86400 |
| `artifact_retention_seconds` | 86400 |
| `reconnect_min_ms`, `reconnect_max_ms` | 500, 30000 |
| `delivery_retry_ms` | 1000; exponential retries capped at 30 seconds |
| `delivery_ack_timeout_ms` | 10000; minimum wait after a result finishes sending |
| `delivery_send_timeout_seconds` | 60; maximum duration for a result upload, range 1–300 |
| `heartbeat_seconds` | 20; connection is stale after three intervals |
| `shutdown_seconds` | 15 |

Every 24-hour default is configurable. Match delivery horizons to the gateway's
return-ticket TTL. File/image and native resource limits retain core defaults;
transport outcomes are bounded to 8 MiB and WebSocket frames to 8 MiB + 128 KiB.
A result exceeding the transport bound becomes an explicit uncertain error.

State directories are private (0700 on Unix; a private Windows ACL); credentials
and config use atomic private-file replacement. Preserve the state directory when
updating or restarting. Deleting it discards delivery/recovery receipts.

## Updates

No release URL from the legacy daemon is reused. Provide the new manifest URL on
the first update; subsequent `update` commands reuse it. The HTTPS manifest:

```json
{
  "protocolVersion": 1,
  "binary": "process-execution-daemon",
  "version": "0.1.0",
  "artifacts": [{
    "os": "macos",
    "arch": "aarch64",
    "url": "https://YOUR-RELEASE-HOST/process-execution-daemon",
    "sha256": "LOWERCASE_SHA256_HEX",
    "sizeBytes": 12345678
  }]
}
```

Artifacts are raw executables; `os`/`arch` use Rust's platform names (`macos`,
`linux`, `windows`; `aarch64`, `x86_64`). The updater bounds download sizes,
checks the SHA-256 and CLI identity before stopping anything, stages beside the
installed binary, and replaces it. A running installation restarts; on Unix a
service-start failure restores the previous binary. Windows uses a helper to
replace the executable after the parent exits. Keep release hosting trusted:
the checksum is authenticated by HTTPS/your manifest, not an independent signature.

For local builds:

```sh
process-execution-daemon update --from /absolute/path/to/new-binary --sha256 VERIFIED_HEX
```

## Verification and rollout status

```sh
cargo test --manifest-path execution/Cargo.toml --workspace
cargo clippy --manifest-path execution/Cargo.toml -p process-execution-daemon --all-targets -- -D warnings
pnpm --filter @managed-agents/execution-gateway-api check
pnpm --filter @managed-agents/user-machines-workers check
```

Tests cover durable admission/recovery, capacity, conflicts, tombstone retention,
canonical hashes, private files, readable CLI output, checksum failure and an
actual update of a temporary binary. The Worker suite launches this real daemon
against Miniflare over TCP, tests registration/renewal, native tools/REPLs/images,
duplicate submission, reconnect, crash recovery and credential revocation.

The daemon is deployed and installed as a LaunchAgent on the test Mac. The real
Cloudflare path is exercised by the
[production benchmark](../../../../EXECUTION_GATEWAY_PRODUCTION_BENCHMARK.md). Service installation and
Windows/Linux runtime behavior have not been exercised on those systems in this
change. The default tests do not install login services, replace the existing
machine daemon, deploy Workers, or publish a release. The deployed benchmark receiver provides durable callback admission for these
tests; existing tool adapters still require migration to this gateway.

Local journal diagnostics record native execution duration, first delivery attempt,
completion/acknowledgement timestamps, attempt count and last delivery error. These
measurements contain no command or file contents and do not change the wire protocol.
