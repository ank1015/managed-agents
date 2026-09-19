# Contracts

Transport-neutral contracts for managed agent sessions and durable operations (Steps 1 and 2). Import the public API from `@managed-agents/contracts`; the package exports TypeScript source for workspace consumers and bundlers.

## Types

| Module | Contracts |
|---|---|
| `json.ts` | `JsonValue` |
| `session.ts` | Session/harness identity, initialization request/result, session info |
| `input.ts` | Event body, submitted input, admitted envelope, receipt |
| `errors.ts` | Error codes, wire error shape, `ContractException` |
| `operation.ts` | Operation definitions/requests, submission/callback correlation, provider submit/status DTOs, outcomes, completion events and receipts |
| `llm.ts` | `llm/generate/v1`, typed messages/tools/fresh and continuation inputs, full assistant responses, private LLM worker submission/destination and binding |
| `pi-bash.ts` | `tool-pi-bash/bash/v1`, Pi model-facing tool definition, command/timeout plus harness-supplied machine/cwd, formatted result/file/truncation details, private worker submission and binding |
| `execution-gateway.ts` | Shared callback routing context, strict v2 terminal events, correlated durable admission receipts and callback-only private binding |

Event types do not establish the authority of the producer. The API must authorize each admission path.

## Validation

The package provides `parseInitializeSessionRequest`, `parseSubmitInputRequest`, and `parseEventBody`. They validate unknown values without coercion and reject unsupported envelope fields. Harnesses validate their own config and payload semantics. Receipts are constructed by the runtime; this package does not implement admission or storage.

`parseJsonValue(value, code?)` accepts finite JSON primitives, dense arrays, and plain objects (including null-prototype objects). It rejects cycles, class instances, getters, symbol/non-enumerable properties, sparse arrays, and other values JSON would drop or rewrite. Repeated references without cycles are accepted. It validates without cloning or freezing: callers must not mutate retained request data. Typed code cannot prove that numbers are finite or values remain JSON-compatible after mutation.

Boundary/envelope failures use `INVALID_REQUEST`. `parseEventBody` uses `INVALID_INPUT`; a non-JSON submitted envelope fails the outer request validation first. Harness config parsers should use `INVALID_CONFIG` for their semantic validation. `ContractException` serializes to `{ code, message }`. Unexpected exceptions must not be converted into successful results.

## Runtime semantics

These semantics are implemented by [the session runtime](../session-runtime/README.md). The contracts package itself only supplies their representations and boundary validation.

- Initialize once; matching retries recover the existing result, and conflicting identity/config returns `INITIALIZATION_CONFLICT`.
- Store validated/defaulted config and enough original request data to recognize initialization retries across changing defaults.
- Deduplicate input by event ID within its session. Compare the event body with `jsonEquals`, which ignores object key order and preserves array order/value differences. Conflicting content returns `INPUT_CONFLICT`.
- Retries retain the original receipt's sequence and timestamp, with `duplicate: true`.
- Sequence numbers are positive safe integers. Timestamps are Unix milliseconds; order comes from sequences, not timestamps.
- Harness writes, operation requests, and input consumption must commit together. These types do not supply that transaction.

## Durable operation contract

`OperationDefinition` contains `{ provider, type, version }`; harness definitions declare an exact allowlist of these combinations. `parseOperationDefinition` validates their shape. `OperationRequest` adds `input`. The provider is a configured logical name. The harness cannot supply a URL, credentials, submission ID, job handle, or callback destination. Request content, including the version, is immutable after commit. Runtime-generated `operationId` identifies the local logical operation; `submissionId` identifies the same request across every delivery retry. Calling `requestOperation` twice creates two operations even when their inputs match.

`ProviderSubmission` carries the request and both correlation IDs. `ProviderStatusQuery` carries the two IDs and the provider's `jobId`. These normalized DTOs are independent of any gateway's HTTP protocol. Matching parsers validate unknown values and reject extra fields, just as the session parsers do.

`ProviderSubmitResult` is one of:

- `accepted`, with a durable `jobId`: the operation worker owns execution and recovery, allowing the session to delete its input.
- `completed`, with `jobId` and terminal outcome.
- `rejected`, with a structured error, only when the provider definitively did not accept the operation.

Transient errors, timeouts, malformed responses, and lost acknowledgements do not prove rejection. They cause retry of the same submission identity. A provider must persist its idempotency mapping for the full recovery horizon, reject changed content for the same identity, and return the original job on resubmission. This contract alone cannot make external file mutations execute exactly once.

`ProviderStatusResult` is `pending`, `completed` with an outcome, or `missing`. A missing accepted job is a recovery/contract error: the runtime records the error and retries status queries with backoff, without resubmitting or fabricating a terminal outcome. The worker owns execution recovery and must preserve accepted job identities. Terminal results must remain queryable when callbacks are absent.

`OperationOutcome` is `succeeded` with JSON result, `failed` with `origin: "execution" | "submission"` and `{ code, message, details? }`, or `cancelled`. The runtime creates submission-origin failures from definitive rejection. Callback and completed-job parsers reject submission-origin failures. `cancelled` represents a provider outcome; Step 2 does not implement cancellation delivery or a harness cancellation policy.

`OperationCompletion` contains `{ provider, operationId, submissionId, jobId, outcome }`. The hosting service must authenticate the provider and authorize the session before runtime admission. Knowing an ID is not authentication. Runtime admission checks the persisted provider/submission relationship and any known job handle. Unknown operations fail with `OPERATION_NOT_FOUND`; inconsistent correlation or conflicting terminal results fail with `COMPLETION_CONFLICT`. Identical repeated completions return the original receipt with `duplicate: true`.

An admitted result generates `RuntimeEvent` (`runtime.operation.completed`) with `{ operationId, outcome }`. Its outcome and inbox record commit atomically. The harness can use its own pending-operation table for context. External input admission reserves both event types beginning `runtime.` and event IDs beginning `runtime:`; clients must use their own namespaces. The generic event parser does not establish producer authority or perform that admission check.

Inputs and outcomes remain full JSON on the wire, each capped separately at 8 MiB UTF-8 (`MAX_OPERATION_INPUT_BYTES`, `MAX_OPERATION_OUTCOME_BYTES`). Parsers include JSON syntax/escaping in the byte count and reject oversize values before persistence. The runtime uses transactional chunk rows for large payloads, rather than a single oversized SQLite row. Request input belongs only to the outbox and its chunks are deleted atomically at acceptance or a terminal outcome. Operation metadata, completion results and completion inbox payloads remain retained. Chunk manifests are internal storage details and never replace JSON in public/provider contracts. R2 references and result/history retention policies remain future work.

The [LLM operation worker](../../apps/llm-gateway-workers/README.md) implements the provider contract using private service bindings. `parseLlmInput` mirrors gateway validation/defaults without exposing gateway credentials, callback configuration or idempotency keys to harness code. `LlmResult` carries `{ gatewayJobId, response }`, preserving provider-native assistant content. This is a wire contract, not a gateway SDK or a replacement for the shared provider interface.

The [Pi-style bash worker](../../apps/tool-pi-bash-workers/README.md) implements the same provider contract through `execution.run`. `PI_BASH_TOOL` exposes only `{ command, timeout? }` to the model; `parseBashInput` additionally requires harness-supplied `machineId` and absolute `cwd`. `BashResult` carries bounded Pi-style text, `isError`, execution status and full-output file/truncation metadata. Known command failure/timeout is a completed operation with `isError: true`; uncertain execution is an execution-origin failure, never permission to resubmit automatically.

The [shared execution callback worker](../../apps/execution-gateway-callback-workers/README.md) receives gateway v2 events carrying worker-generated `clientContext: { receiver, reference }`, then durably forwards them to allowlisted private bindings. This infrastructure convention is narrower than the gateway's opaque JSON object support; these parsers require exactly those routing keys. `GatewayEventReceiverBinding` exposes only `acceptGatewayEvent`, with a `GatewayEventReceipt` after durable admission. Parsers establish shape, not authentication: the shared receiver verifies the gateway signature, and tool workers restrict access to trusted service bindings and validate retained operation correlation. Session runtime contracts are unchanged.

## Checks

Run `pnpm --filter @managed-agents/contracts check` or root `pnpm check`. Tests use Node's built-in test runner and TypeScript support (Node 22.18+); source and tests are also checked by TypeScript.
