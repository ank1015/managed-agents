# Execution gateway protocol v1

Shared TypeScript validation, machine credential helpers, canonical hashes and
callback contracts for the [gateway](../../apps/execution-gateway/README.md).
Native parameter/result schemas remain owned by
[process-execution-core](../process-execution-core/README.md).

This is a breaking machine-secret contract retaining protocol version 1. Update the
daemon, gateway and callback receivers together. Use fresh machine registrations
and application sessions; user/grant/scope contracts are not accepted.

## Machine connection

The daemon connects to `GET /v1/machines/:machineId/connect` with its `md1`
daemon secret. The gateway replies:
```json
{"type":"welcome","protocolVersion":1,"machineId":"<uuid>","connectionEpoch":1}
```
The daemon sends `hello` with protocolVersion, runtimeGeneration, daemonVersion,
os, arch and supported operations. The gateway sends `ready` with protocolVersion,
connectionEpoch and runtimeGeneration. Repeat identical hello messages are allowed;
changing capabilities or generation requires reconnecting.

Text `execution:ping` receives `execution:pong` automatically. Secret versions
revoke daemon connections independently of execution access. There are no token
expiry timestamps or renewal messages.

## Submission and identity

The HTTP body is `{requestId,runtimeGeneration,operation,callback}`.
`operation` is `{operation,params}`; callback is `{receiver,context}`.
Context is bounded JSON, defaulting to null when omitted, and is returned unchanged.
Receiver names resolve exclusively to allowlisted private service bindings.

```text
requestHash = hashJson({machineId, requestId, runtimeGeneration, operation, callback})
resultHash = hashJson(outcome)
deliveryId = hashJson({requestHash, resultHash})
```

Canonical JSON recursively sorts keys using JavaScript UTF-16 ordering, preserves
array order, and uses JavaScript JSON number/string serialization. Hashes are
lowercase SHA-256 over UTF-8 bytes. Credential values/versions are excluded from
request identity, so rotation does not change an otherwise identical request.

The gateway sends:
```json
{
  "type":"request","protocolVersion":1,"dispatchId":"<attempt-uuid>",
  "requestId":"<stable-request-id>","requestHash":"<sha256>",
  "runtimeGeneration":"<uuid>","operation":{"operation":"runtime.capabilities","params":{}},
  "routingEnvelope":"<signed-envelope>"
}
```

The daemon durably reserves capacity before `accepted`. It echoes dispatchId,
requestId, requestHash and runtimeGeneration on accepted/rejected replies.
Rejections include `error:{code,message,retryable,uncertain}`. A fresh HTTP retry
has a fresh dispatchId but the same stable identity/hash. IDs are global within a
machine runtime. Different input under the same ID must never execute again.

## Routing envelopes and callbacks

Routing envelopes are HMAC-SHA256 signed JWT-shaped messages with fixed kind
`routing` and audience `managed-execution-v1`. They contain machineId,
runtimeGeneration, requestId, requestHash and callback. They have no expiry.
They authenticate result routing, not access to execution or machine management.
The daemon saves and returns the opaque envelope; native params/results and
machine secrets are never embedded in it. Callback context is signed, not encrypted.

A daemon result is:
```json
{"type":"result","deliveryId":"<sha256>","routingEnvelope":"<saved-envelope>","outcome":{"status":"ok","result":{}}}
```
An execution failure is still a completed outcome:
`{status:"error",error:{code,message,uncertain}}`.

The DO verifies current daemon authorization, the envelope's machine binding,
payload limits and hashes, then invokes:
```ts
acceptExecutionResult(event: CompletionEvent): Promise<CompletionReply>
```
Event fields: protocolVersion, machineId, runtimeGeneration, requestId, requestHash,
callback, deliveryId, resultHash and outcome.

The receiver must validate callback context and expected application request
identity, then durably deduplicate by machineId/runtimeGeneration/requestId.
Identical duplicates return the original admission receipt; conflicting
request/result hashes must not replace admitted content.

```ts
{status:"accepted", deliveryId, requestId, requestHash, resultHash}
// or
{status:"rejected", code:"COMPLETION_CONFLICT", retryable:false}
```

Only a matching accepted receipt produces `result_ack` with all four correlation
fields. Errors produce `result_nack` with deliveryId and error retryability.
Exceptions, wrong receipts and deadlines can mean the receiver already committed.
They are retried, never interpreted as rollback.

The daemon owns the outbox and retries the same saved delivery. A permanent nack
or local delivery horizon quarantines it. The DO persists no per-request routing
or results. Old-runtime results can be delivered after daemon restart with their
original envelope; old-runtime operations cannot be executed in the new core.

## Operations

`execution.exec`, `execution.interact`, `execution.close`;
`filesystem.read`, `filesystem.write`, `filesystem.patch`;
`repl.execute`, `repl.collect`, `repl.interrupt`, `repl.reset`, `repl.close`;
`request.cancel` with `{request_id}`; `runtime.capabilities` with `{}`.

Native requests carry their own absolute cwd and environment overrides. Process
and REPL handles are UUIDs. No users, task scopes, resource groups or grants exist.
The execution secret authorizes all supported operations on its machine; OS
permissions and any sandbox enforcement belong to that machine.
