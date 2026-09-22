# Tool-facing execution gateway contract

The harnesses and five tools depend on this interface, not on a particular
gateway deployment or daemon implementation. The repository's
[execution gateway](../../execution/apps/execution-gateway/README.md) is one
implementation. An app may own registration, machine management and its daemon
as long as its gateway implements the interface below.

## Configuration and trust

Each session's immutable harness config includes:

```json
{
  "executionGatewayUrl": "https://execution.example.com",
  "machineId": "22222222-2222-4222-8222-222222222222",
  "executionToken": "<machine execution secret>"
}
```

Both current harnesses require these fields alongside their model and cwd
configuration. The gateway URL must be an HTTPS origin, optionally with a port
or trailing slash. Host casing and default ports are canonicalized. Credentials,
paths, query strings and fragments are rejected. There is no deployment-wide
gateway URL or fallback. Changing gateway, machine or token requires a new session.

The authenticated app backend chooses the gateway. This choice authorizes sending
that session's execution token and native operations to the selected origin; it
must not come from model arguments or untrusted user-controlled routing fields.
An app admitting untrusted creators should enforce its own gateway allowlist.
HTTPS-origin validation is not a DNS/private-network allowlist. Neither discovery
nor submission follows redirects.

The current credential contract remains
`me1.<machine UUID>.<positive integer version>.<43 base64url characters>`.
Tools validate the encoding and machine ID; the selected gateway authenticates
the secret and enforces authorization. Gateway-specific signing keys and secret
storage are not shared with tools. Arbitrary opaque token formats are not supported
by this version.

## Discovery: host to gateway

`GET /v1/machines/:machineId`, with `Authorization: Bearer <executionToken>`.
A successful JSON response must contain:

```json
{
  "machine": {
    "machineId": "22222222-2222-4222-8222-222222222222",
    "connectionStatus": "ready",
    "runtimeGeneration": "33333333-3333-4333-8333-333333333333"
  }
}
```

Other machine metadata is allowed. Discovery must finish within seven seconds
with a response no larger than 64 KiB. Non-ready machines cannot start tool work.
The host persists gateway origin, machine ID, runtime generation and session
destination before dispatch. Reconnects may retain a generation; a daemon runtime
reset must change it. A session never silently switches to another runtime.

The host calls the tool's private RPC:

```ts
submit({
  destination: { routeKey, sessionId },
  execution: { gatewayUrl, token, runtimeGeneration },
  submission: { operationId, submissionId, request }
})
```

`gatewayUrl` is the canonical `config.executionGatewayUrl`. Execution context is
outside model/native operation input. Secrets are excluded from callbacks and
transcripts.

## Submission: tool to gateway

`POST /v1/machines/:machineId/requests`, with the same bearer credential and JSON:

```ts
{
  requestId, runtimeGeneration,
  operation: { operation, params },
  callback: { receiver, context }
}
```

The tool constructs native params and a stable request ID. Preserve the complete
callback object unchanged: its context includes the gateway origin and session
correlation, but no credential. The gateway returns **HTTP 202** with exactly:

```ts
{ status: "accepted", machineId, requestId, requestHash, runtimeGeneration }
```

Acceptance means the execution side has durably accepted this identity, not that
execution has finished. Replaying the same ID and body must not repeat its side
effects. Different content for a retained ID must conflict. A mismatched runtime
must not execute. Secret rotation must not change request identity.

Failures return a non-202 status and exactly:

```ts
{ error: { code, message, retryable, uncertain } }
```

`code` and `message` are strings; `retryable` and `uncertain` are booleans.
Codes are bounded protocol identifiers. Use `uncertain: true` whenever work may
already have been accepted. The tool's submission budget is seven seconds.
Timeouts and malformed responses after dispatch cannot authorize a new request ID.

## Completion: gateway to tool to session

Callbacks remain **private Cloudflare service-binding RPC**, not public URLs:

| Receiver | Tool entrypoint | Native operation |
|---|---|---|
| `tool-pi-bash-v1` | `PiBashCallbacks` | `execution.exec` |
| `tool-pi-read-v1` | `PiReadCallbacks` | `filesystem.read` |
| `tool-pi-write-v1` | `PiWriteCallbacks` | `filesystem.write` |
| `tool-pi-edit-v1` | `PiEditCallbacks` | `filesystem.patch`, text replacements |
| `tool-codex-apply-patch-v1` | `CodexApplyPatchCallbacks` | `filesystem.patch`, Codex format |

Each gateway must configure these receiver names to the matching private bindings
for the tools it supports. Call `acceptExecutionResult(event)` with:

```ts
{
  protocolVersion: 1, machineId, runtimeGeneration, requestId, requestHash,
  callback, deliveryId, resultHash,
  outcome: { status: "ok", result }
  // or outcome: { status: "error", error: { code, message, uncertain } }
}
```

Native parameter/result schemas must match
[process-execution-core](../../execution/packages/process-execution-core/README.md).
Canonical hashing, payload bounds, event validation and receipts are defined by
the [execution gateway protocol](../../execution/packages/execution-gateway-protocol/README.md)
and its exported validators:

```text
requestHash = hashJson({machineId, requestId, runtimeGeneration, operation, callback})
resultHash = hashJson(outcome)
deliveryId = hashJson({requestHash, resultHash})
```

The tool calls the session's `acceptToolCompletion` with
`{execution:{gatewayUrl,machineId,runtimeGeneration},completion}`.
All three execution fields must match the persisted pin, even if two gateways
use identical machine and runtime IDs. The runtime then checks operation identity
and durably deduplicates admission. Only after admission does the tool acknowledge:

```ts
{ status: "accepted", deliveryId, requestId, requestHash, resultHash }
```

Lost receipts, exceptions or timeouts require retrying the identical completion.
The delivery owner must retain results until a matching durable receipt; our
implementation uses the daemon outbox. Do not re-execute an operation to recover
delivery. Tool callbacks have a six-second budget.

The origin in callback context is a correlation check, not proof of its sender.
Private callback bindings are the trust boundary: only trusted gateways may hold
them. App-owned gateways outside that private-binding environment need a separately
designed authenticated delivery adapter; changing the URL alone does not provide
cross-account/provider callbacks. No public webhook fallback is implemented.

## Rollout

This is a breaking session, tool-RPC and callback-context change. Drain outstanding
old operations before deploying matching hosts and all tools. Create new sessions
with the required URL; old sessions and callbacks without it are not migrated.
The existing gateway/daemon forward opaque callback context already, so they need
no protocol change for this field. Registration and management endpoints are not
part of the tool-facing contract.
