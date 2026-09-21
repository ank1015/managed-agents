# Execution gateway

One Cloudflare Worker deployment containing the public HTTP router and one SQLite
`Machine` Durable Object per machine. The daemon connects outbound using a
hibernating WebSocket. The gateway validates and routes work; the daemon owns
durable request admission, execution receipts, and the result outbox.

## Public API

All credentials use `Authorization: Bearer …`. Query parameters are rejected.
JSON bodies require `Content-Type: application/json`.

| Method | Route | Credential | Body / response |
|---|---|---|---|
| GET | `/health` | none | service and protocol metadata |
| POST | `/v1/machines` | management | `{machineId,name}` → `{machine,daemonSecret,executionSecret,duplicate}` |
| GET | `/v1/machines/:id` | execution | `{machine}` |
| POST | `/v1/machines/:id/secrets/rotate` | management | `{kind:"daemon"\|"execution",expectedVersion}` → `{machineId,kind,version,secret}` |
| DELETE | `/v1/machines/:id` | management | `{deleted:true,machineId}` |
| GET | `/v1/machines/:id/connect` | daemon | WebSocket upgrade |
| POST | `/v1/machines/:id/requests` | execution | submission → HTTP 202 after daemon acceptance |

There are no users, grants, expiring machine tokens, token refresh, machine listing,
public result polling, or arbitrary callback URLs. Request cancellation, process
interaction/closing, and REPL controls use the submission endpoint.

Machine discovery includes connection status, current runtime generation, daemon
capabilities and independent `daemonSecretVersion` / `executionSecretVersion`.
It never returns secret values or stored hashes.

Registration returns 201; an identical retry returns 200 and the same initial
secrets. Persist a caller-generated machine UUID before registering. A changed
name conflicts. After either secret rotates, registration retries return
`REGISTRATION_ROTATED`; recover the rotation response or configure the current
daemon secret instead.

Rotation independently increments the selected secret version. Retrying the same
`expectedVersion` while it is the preceding version returns the same issued
secret. Older versions conflict. Daemon rotation closes the socket; configure
the replacement secret and reconnect. Execution rotation blocks new submissions
with the old secret without disrupting the daemon or saved result delivery.

Deletion immediately revokes both roles, closes sockets, and prevents new result
delivery. A callback already committing cannot be rolled back. A permanent
tombstone prevents re-registration of the deleted machine ID. Deletion retries
are idempotent. The daemon retains unacknowledged results in its local outbox.

## Credentials and deployment

Configure three independent secrets of at least 32 random bytes:

- `MANAGEMENT_SECRET`: registration, rotation and deletion only.
- `CREDENTIAL_SIGNING_SECRET`: stable credential issuance key. HMAC over machine,
  role and version makes registration/rotation responses recoverable. Only hashes
  are stored in the machine DO; authorization checks those hashes and versions.
  Keep this key stable. Changing it does not revoke already stored credentials,
  but prevents recovering old issuance responses; explicit rotation issues new
  credentials under the replacement key.
- `ROUTING_SIGNING_SECRET`: authenticates callback routing envelopes.
  `ROUTING_PREVIOUS_SIGNING_SECRET` can verify outstanding envelopes during key
  rotation. Retain the old verification key until its outboxes drain.

Daemon secrets have format `md1.<machine-uuid>.<version>.<secret>`; execution
secrets use `me1`. They do not expire. Identity/version fields are routing and
sanity-check information; they do not authenticate the secret.

The committed Wrangler configuration uses a new `managed-agents-execution-gateway-v1`
Worker and a new `Machine` SQLite namespace. It binds the four Pi callback
entrypoints. Source changes are not a deployment or data migration. Coordinate
the daemon, gateway, tool receivers, session hosts and agent API rollout.
Register fresh machine identities and create fresh sessions. The old UserMachines
namespace and deployed services are not deleted by this change.

## Submission and callback

```json
{
  "requestId": "caller-generated-uuid",
  "runtimeGeneration": "10000000-0000-4000-8000-000000000001",
  "operation": {
    "operation": "execution.exec",
    "params": {
      "cwd": "/absolute/path",
      "command": {"type": "shell", "script": "printf hello"},
      "completion": {"mode": "finished", "timeout_ms": 10000}
    }
  },
  "callback": {
    "receiver": "tool-pi-bash-v1",
    "context": {"routeKey": "pi-no-compaction-v1", "sessionId": "session-123", "operationId": "operation-456"}
  }
}
```

Callback context is opaque to the gateway and bounded to 8 KiB. Real Pi adapters
supply their complete operation correlation and input fingerprints. The gateway
checks that the receiver names a configured private binding; the receiver validates
its context, application session and expected operation before admitting the result.

The DO hashes the complete request including machine ID and callback, signs a
routing envelope, and sends both operation and envelope to the daemon. It waits
briefly for matching durable acceptance before returning:

```json
{"status":"accepted","machineId":"…","runtimeGeneration":"…","requestId":"…","requestHash":"…"}
```

The DO can hibernate after this response. The daemon persists its result, sends
it with the saved envelope, and retries delivery until acknowledged. The DO
wakes, verifies the envelope and result hashes, and calls
`acceptExecutionResult(event)` on the private receiver. Only a matching durable
receipt earns `result_ack`. Receiver errors, deadlines and lost acknowledgements
remain retryable; conflicting results are rejected permanently.

The DO holds no request rows, callback routing table per request, result archive,
or delivery queue. The signed envelope survives in the daemon journal. It has no
time expiry, so it remains usable after execution-secret rotation or daemon
restart. The current socket must still have valid daemon authorization.
Retrying delivery while the callback is unavailable requires the machine to stay
online or reconnect.

Receiver bindings are configured as:
```jsonc
"vars": {"CALLBACK_ROUTES": "{\"tool-pi-bash-v1\":\"BASH_EVENTS\"}"},
"services": [{"binding":"BASH_EVENTS","service":"managed-agents-tool-pi-bash","entrypoint":"PiBashCallbacks"}]
```

## Reliability and limits

Offline/capacity errors before dispatch are unstarted. A lost acceptance response
is `SUBMISSION_UNCERTAIN`; retry the exact request ID, runtime, operation and
callback. Never manufacture a new ID to retry uncertain work. Completion can
arrive before the HTTP acceptance response; receivers must know the expected
identity before submission.

Connection epochs fence stale sockets. Core generations fence execution after a
daemon restart. Saved results from an older core may be delivered on a new socket.
The daemon reports unfinished crash-time operations as uncertain rather than
rerunning them. Native operations retain their core-defined yield/finish semantics.

| Setting | Default | Bounds |
|---|---|---|
| MAX_PENDING_SUBMISSIONS | 8 | 1–64 per machine |
| MAX_CONCURRENT_DELIVERIES | 2 | 1–8 per machine |
| MAX_BUFFERED_BYTES | 16777216 | 8519680–67108864 per machine |
| ACCEPT_TIMEOUT_MS | 5000 | 10–30000 |
| CALLBACK_TIMEOUT_MS | 8000 | 10–30000; deployed config uses 30000 for image uploads |

Native payloads are limited to 8 MiB, HTTP bodies to 8 MiB + 64 KiB, WebSocket
frames to 8 MiB + 128 KiB. Body reads have an 8-second deadline. Buffer reservations
bound admitted wire bytes, not total heap usage. Automatic text heartbeat replies
allow idle sockets to hibernate without periodic SQL writes.

## Verification

```sh
pnpm --filter @managed-agents/execution-gateway-protocol check
pnpm --filter @managed-agents/execution-gateway check
cargo test --manifest-path execution/Cargo.toml -p process-execution-daemon
```

Tests run real SQLite DOs and private callbacks in Miniflare, including hibernation,
role separation, rotation/deletion, acceptance loss, duplicates, late admission,
conflicts and 7 MiB results. Real-core and real-daemon tests cover native tools,
REPLs, images, TCP reconnects and crash/outbox recovery in temporary directories.

The checked-in callback bindings include all five Workers under `apps/tools/`,
including `tool-codex-apply-patch-v1 → APPLY_PATCH_EVENTS → CodexApplyPatchCallbacks`.
Apply-patch uses `filesystem.patch` with `format: "codex"`, not a separate legacy
apply-patch operation. Its production session routes remain unconfigured until a
harness adopts the tool.
