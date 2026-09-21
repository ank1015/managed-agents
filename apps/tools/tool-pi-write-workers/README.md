# Pi-style write worker

Stateless `tool-pi-write/write/v1` provider using the new execution gateway's
`POST /v1/machines/:machineId/requests` API and native `filesystem.write` operation. This is a breaking
migration: the old jobs API, shared gateway API key, HMAC webhook envelope and
`acceptGatewayEvent` callback are removed.

## Model input and result

Pi's model arguments remain exactly `{ path: string, content: string }`. The trusted
caller adds `machineId` and absolute `cwd` to the operation input. Paths use normal
machine filesystem resolution, without tilde or `@` expansion. Empty content is
valid. UTF-8 bytes, BOM, newline style and NUL characters in content are preserved;
paths cannot contain NUL. No shell is invoked.

Success text remains `Successfully wrote to <input path>`. The result includes
`content`, `isError: false`, and adapter metadata:

```ts
{
  requestId, machineId, path,
  file: { path: absolutePath, mutationId, sha256, bytesWritten, disposition }
}
```

`details.requestId` replaces `details.gatewayJobId`. Mutation ID, digest, byte count,
absolute path and disposition are verified before reporting success. Ordinary
filesystem errors become Pi tool results with `isError: true`. Uncertain outcomes
become failed operations with `WRITE_OUTCOME_UNKNOWN`; inspect the file before
explicitly deciding to issue another write.

New content is capped at **5 MiB of UTF-8 bytes**. Oversized content within the
transport budget completes locally with a tool error, without contacting the
gateway. The generic operation input limit remains **8 MiB of serialized JSON**;
JSON escaping can exhaust it before the content cap. Gateway request and context
limits also apply. These limits do not increase LLM response or session-history
limits.

## Session DO submission

`PiWrite.submit` is a private service entrypoint and returns `{ result }`. The DO
must supply execution authorization outside model arguments and retained messages:

```ts
{
  destination: { routeKey: "pi-no-compaction-v1", sessionId: "session-123" },
  execution: {
    token: "<machine execution secret>",
    runtimeGeneration: "<runtime UUID>",
  },
  submission: {
    operationId: "operation-123",
    submissionId: "submission-123",
    request: {
      provider: "tool-pi-write", type: "write", version: "v1",
      input: { machineId: "<machine UUID>", cwd: "/workspace", path: "file.txt", content: "Hello\n" }
    }
  }
}
```

The caller pins the runtime and supplies that machine's execution secret.
The worker checks the secret's machine identity; the gateway authenticates its
hash and current version. Secrets stay outside model input and history. The
callback receiver is fixed to `tool-pi-write-v1`; its context carries the session
route, operation identities and input fingerprints. No temporary grant or
account-wide execution credential is involved.

Pin the runtime,
submission identity and input for retries; replace only with a same-machine token. Never
retarget an uncertain write to a new runtime. The harness is responsible for supplying current credentials; tests exercise
that private submission contract without prescribing a credential store.

## Native operation and return flow

The worker sends one request with a stable request ID:

```ts
{
  requestId: "pi-write-v1:<SHA-256 of submissionId>",
  runtimeGeneration,
  operation: {
    operation: "filesystem.write",
    params: {
      cwd, path,
      content: { type: "base64", data: "SGVsbG8K" },
      create_parents: true
    }
  },
  callback: { receiver: "tool-pi-write-v1", context: { /* routeKey, sessionId; identities, cwd/path, content digest and byte count */ } }
}
```

Base64 preserves exact UTF-8 bytes and bounds JSON escaping overhead. The core uses
the request ID as its mutation ID. No precondition is supplied. Parent directories
are created; the native core handles overwrite and symlink behavior. Context
contains neither credentials nor file content.

1. DO → `PiWrite` → execution API → Machine DO → daemon.
2. HTTP 202 confirms acceptance, not completion. The provider's generic `jobId`
   field carries the stable request ID; there is no remote job-detail lookup.
3. Daemon result → Machine DO → private
   `PiWriteCallbacks.acceptExecutionResult` → Session DO `acceptToolCompletion`.
4. Only a matching durable Session DO admission receipt permits the worker to return
   `{ status: "accepted", deliveryId, requestId, requestHash, resultHash }`.
5. Machine acknowledges delivery to the daemon. Failed/lost callback receipts
   are retried; the Session DO deduplicates completion admission.

Callbacks may arrive before HTTP acceptance. The worker verifies protocol and
runtime identity, result hashes and the native write receipt. Lost or malformed
acceptance is retried with the same request identity, never a fresh write identity.
Auth failures and runtime conflicts are surfaced for caller refresh/reconciliation.
The daemon owns execution journals and result redelivery; this worker has no D1,
DO, Queue or independent delivery ledger. Guarantees remain bounded by daemon
journal retention and runtime lifetime.

Submission has a seven-second deadline; completion delivery has six seconds,
leaving room within the configured gateway callback timeout. A late Session DO
commit remains safe to retry through durable admission deduplication. Timeout or
cancellation does not undo an accepted write. Public HTTP exposes only `/health`.

## Configuration and rollout

- `EXECUTION_GATEWAY_URL=https://execution-api.acentric.dev`.
- Session namespace bindings and `SESSION_ROUTES` allowlist route completions.
- Machine config binds `WRITE_EVENTS` to
  `managed-agents-tool-pi-write/PiWriteCallbacks` and routes `tool-pi-write-v1` there.
- No shared callback-router deployment is required for this tool.

Coordinate the caller execution-context migration and drain old writes before a
production cutover. Deploy the write worker before the Machine binding, then
use its matching private callback binding. This contract is deployed; see the [deployment record](../../../execution/DEPLOYMENT.md).

## Verification

```sh
pnpm --filter @managed-agents/tool-pi-write-workers check
pnpm --filter @managed-agents/contracts check
```

Workerd tests cover private RPC, actual SessionDriver/SQLite DO admission, machine-secret
routing, request identity across secret replacement, lost acceptance, early and duplicate
callbacks, lost/invalid durable receipts, DO restart, errors and size boundaries.

The native integration test builds the repository's Rust daemon with Cargo and runs
a temporary daemon through the real local gateway API/Machine stack. It
checks nested creation, overwrite, empty content, Unicode/CRLF/NUL preservation,
symlinks, filesystem errors and replay of an earlier write after a later mutation.
It uses isolated temporary files and does not replace or stop the installed daemon.


The harness supplies `execution: { token, runtimeGeneration }` on every submit.
The token must be this machine's `me1.…` execution secret. This worker neither
stores nor discovers, rotates or refreshes it. Different submissions can target
different machines with different tokens; the harness owns that choice.
Credential storage and replacement are outside this tool's contract.

Only the current [execution gateway](../../../execution/apps/execution-gateway/README.md)
is supported. User credentials, temporary grants, daemon secrets, legacy jobs
responses and public webhook envelopes are rejected; there is no compatibility
fallback. Malformed replies after dispatch are uncertain and must be retried with
the same request identity. A replacement secret does not change that identity.
