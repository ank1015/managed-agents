# Contracts

Transport-neutral contracts for managed agent sessions and durable operations (Steps 1 and 2). Import the public API from `@managed-agents/contracts`; the package exports TypeScript source for workspace consumers and bundlers.

## Types

| Module | Contracts |
|---|---|
| `json.ts` | `JsonValue` |
| `session.ts` | Session/harness identity, initialization request/result, session info |
| `api.ts` | Session creation/listing, lifecycle/display statuses, message pagination and private session commands |
| `input.ts` | Event body, submitted input, admitted envelope, receipt |
| `errors.ts` | Error codes, wire error shape, `ContractException` |
| `operation.ts` | Operation definitions/requests, submission/callback correlation, provider submit/status DTOs, outcomes, completion events and receipts |
| `llm.ts` | `llm/generate/v1`, typed messages/tools/fresh and continuation inputs, full assistant responses, private LLM worker submission/destination and binding |
| `pi-bash.ts` | `tool-pi-bash/bash/v1`, Pi model-facing tool definition, command/timeout plus harness-supplied machine/cwd, formatted result/file/truncation details, private worker submission and binding |
| `pi-read.ts` | `tool-pi-read/read/v1`, Pi path/offset/limit tool schema, host-supplied machine/cwd, bounded text or image URL result, private worker submission and binding |
| `execution-gateway.ts` | Shared callback routing context, strict v3 inline terminal events, correlated durable admission receipts and callback-only private binding |

Event types do not establish the authority of the producer. The API must authorize each admission path.

## Validation

The package provides `parseInitializeSessionRequest`, `parseSubmitInputRequest`, and `parseEventBody`. They validate unknown values without coercion and reject unsupported envelope fields. Harnesses validate their own config and payload semantics. Receipts are constructed by the runtime; this package does not implement admission or storage.

`parseJsonValue(value, code?)` accepts finite JSON primitives, dense arrays, and plain objects (including null-prototype objects). It rejects cycles, class instances, getters, symbol/non-enumerable properties, sparse arrays, and other values JSON would drop or rewrite. Repeated references without cycles are accepted. It validates without cloning or freezing: callers must not mutate retained request data. Typed code cannot prove that numbers are finite or values remain JSON-compatible after mutation.

Boundary/envelope failures use `INVALID_REQUEST`. `parseEventBody` uses `INVALID_INPUT`; a non-JSON submitted envelope fails the outer request validation first. Harness config parsers should use `INVALID_CONFIG` for their semantic validation. `ContractException` serializes to `{ code, message }`. Unexpected exceptions must not be converted into successful results.

## Runtime semantics

These semantics are implemented by [the session runtime](../session-runtime/README.md). The contracts package itself only supplies their representations and boundary validation.

- Initialize once; duplicate internal requests recover resolved config, and conflicting identity returns `INITIALIZATION_CONFLICT`.
- Store only validated/defaulted config in the DO. Agent-api retains a canonical creation-request hash for `CREATION_CONFLICT` detection, not the full submitted payload.
- Deduplicate input by event ID within its session using a canonical SHA-256 event hash. Object key order is ignored; array order/value differences matter. Conflicting content returns `INPUT_CONFLICT`. Consumed inbox payloads are cleared while hashes and original receipts remain.
- Retries retain the original receipt's sequence and timestamp, with `duplicate: true`.
- Sequence numbers are positive safe integers. Timestamps are Unix milliseconds; order comes from sequences, not timestamps.
- After submissions resolve, harness writes, small acceptance receipts, immediate/rejected completion events and source consumption commit together. These types do not supply that transaction.

`SessionStatus` combines API lifecycle states (`initializing`, `initialization_failed`, `destroyed`) with `HarnessStatus` (`idle`, `running`, `failed`, `cancelling`, `cancelled`, `waiting`). The API marks initial idle; subsequent display statuses are explicit harness choices, published best-effort to D1 after commit. They are not stored or inferred by the session runtime and do not replace internal execution state.

## Durable operation contract

`OperationDefinition` contains `{ provider, type, version }`; harness definitions declare an exact allowlist of these combinations. `parseOperationDefinition` validates their shape. `OperationRequest` adds `input`. The provider is a configured logical name. The harness cannot supply a URL, credentials, submission ID, job handle, or callback destination. Request content must be deterministic across replay. The harness returns operations with unique stable keys; the runtime derives an ID from session/harness/input sequence/key. `operationId` and `submissionId` use that same derived value. Distinct keys produce separate jobs; replaying one key must recover the same job.

`ProviderSubmission` carries the request and both correlation IDs. `ProviderStatusQuery` carries the two IDs and the provider's `jobId`. These normalized DTOs are independent of any gateway's HTTP protocol. Matching parsers validate unknown values and reject extra fields, just as the session parsers do.

`ProviderSubmitResult` is one of:

- `accepted`, with a durable `jobId`: the operation worker owns execution and recovery, allowing the session to delete its input.
- `completed`, with `jobId` and terminal outcome.
- `rejected`, with a structured error, only when the provider definitively did not accept the operation.

Transient errors, timeouts, malformed responses, and lost acknowledgements do not prove rejection. They cause retry of the same submission identity. A provider must persist its idempotency mapping for the full recovery horizon, reject changed content for the same identity, and return the original job on resubmission. This contract alone cannot make external file mutations execute exactly once.

`ProviderStatusResult` is `pending`, `completed` with an outcome, or `missing`. It is retained for private worker diagnostics, not runtime polling. The worker owns accepted-job recovery/delivery and must preserve job identities. Missing accepted upstream jobs remain recovery errors, not permission to re-execute them.

`OperationOutcome` is `succeeded` with JSON result, `failed` with `origin: "execution" | "submission"` and `{ code, message, details? }`, or `cancelled`. The runtime creates submission-origin failures from definitive rejection. Callback and completed-job parsers reject submission-origin failures. `cancelled` represents a provider outcome; Step 2 does not implement cancellation delivery or a harness cancellation policy.

`OperationCompletion` contains `{ provider, operationId, submissionId, jobId, outcome }`. The hosting service must authenticate the provider and authorize the session before runtime admission. Knowing an ID is not authentication. Runtime admission checks the persisted provider/submission relationship and any known job handle. Unknown operations fail with `OPERATION_NOT_FOUND`; inconsistent correlation or conflicting terminal results fail with `COMPLETION_CONFLICT`. Identical repeated completions return the original receipt with `duplicate: true`.

An admitted result generates `RuntimeEvent` (`runtime.operation.completed`) with `{ operationId, provider, jobId, outcome }`. Its body exists only in the inbox until consumption. Early callbacks validate against the reconstructed head plan; later ones match pending acceptance receipts. The harness retains whatever context it needs in its own state. External input admission reserves event types beginning `runtime.` and IDs beginning `runtime:`; clients must use their own namespaces.

Inputs and outcomes remain full JSON on the wire. `MAX_OPERATION_INPUT_BYTES` is 8 MiB; `MAX_OPERATION_OUTCOME_BYTES` is 1,900,000 bytes. Parsers include JSON syntax/escaping in the UTF-8 byte count. Workers convert oversized gateway results to small terminal failures, so the harness can fail the run rather than endlessly retrying delivery. Outgoing requests are in-memory only. Incoming events and harness messages use plain inline SQLite JSON, not chunk tables or manifests. `MAX_INLINE_ROW_BYTES` reserves a 1,950,000-byte budget for inbox JSON/identity/hash under the platform's 2 MB row limit. Incoming completion bodies are cleared when their harness transition commits, together with their small pending acceptance receipt. Consumed inbox hashes remain for deduplication; no historical runtime outcome ledger remains. R2 references and result/history retention policies remain future work.

The [LLM operation worker](../../apps/llm-gateway-workers/README.md) implements the provider contract using private service bindings. Its stateless adapter supplies host-owned `clientContext` to the gateway, which owns idempotency and callback retries. The LLM binding exposes only `submit`; the old diagnostic `get` is removed. `parseLlmInput` mirrors gateway validation/defaults without exposing gateway credentials, routing context, callback configuration or idempotency keys to harness code. `LlmResult` carries `{ gatewayJobId, response }`, preserving provider-native assistant content. This is a wire contract, not a gateway SDK or a replacement for the shared provider interface.

Its signed gateway callback now requires `schemaVersion: 2` and inline `response`/`error`, normalized by the worker without a result GET. Terminal submission replay still fetches job detail. Public runtime `OperationCompletion` and receipt contracts are unchanged.

The [Pi-style bash worker](../../apps/tool-pi-bash-workers/README.md) implements the same provider contract through `execution.run`. `PI_BASH_TOOL` exposes only `{ command, timeout? }` to the model; `parseBashInput` additionally requires harness-supplied `machineId` and absolute `cwd`. `BashResult` carries bounded Pi-style text, `isError`, execution status and full-output file/truncation metadata. Known command failure/timeout is a completed operation with `isError: true`; uncertain execution is an execution-origin failure, never permission to resubmit automatically.

The standalone [Pi-style read worker](../../apps/tool-pi-read-workers/README.md) uses `filesystem.read_file`. `PI_READ_TOOL` exposes `{ path, offset?, limit? }`; `parseReadInput` adds host-supplied machine/cwd. `ReadResult` carries bounded text or a Cloudflare Images URL, file/truncation/image metadata and `isError`. Files above 5 MiB and ordinary filesystem errors are completed tool errors. Production harness adoption is intentionally separate.

The [shared execution callback worker](../../apps/execution-gateway-callback-workers/README.md) accepts signed v3 inline events with response/error, job/machine/key/generation identity and host-owned context. `ExecutionGatewayContext` requires an allowlisted receiver name; other JSON fields remain tool-owned. Bash requires exact session/operation/machine/timeout routing context. `GatewayEventReceiverBinding.acceptGatewayEvent` uses structured RPC and returns `{ receipt: GatewayEventReceipt }` only after durable DO admission. `parseGatewayEventReply` validates the nested receipt and disposes the RPC wrapper. There is no intermediate delivery database, Queue or early acknowledgement; the gateway owns retries. Parsers establish shape, not authentication. Runtime completion contracts are unchanged.

Structured private submit RPC returns `ProviderSubmitReply = { result: ProviderSubmitResult }`. `parseProviderSubmitReply` validates the nested JSON result and disposes Cloudflare's outer RPC object. The runtime provider interface itself returns the unwrapped `ProviderSubmitResult`. Runtime completion events now contain `{ operationId, provider, jobId, outcome }`, with null jobId only for a definitive rejected submission.

## Checks

The private session RPC uses structured `SessionCommand` / `SessionReply` objects, not JSON strings. `parseSessionCommand` checks only the dispatch envelope; each action validates its payload at admission. The API checks HTTP syntax/size and the DO validates submitted inputs. Gateway-worker `submit` and execution callback forwarding are structured. The bash diagnostic `get` is removed along with its local operation ledger.

Run `pnpm --filter @managed-agents/contracts check` or root `pnpm check`. Tests use Node's built-in test runner and TypeScript support (Node 22.18+); source and tests are also checked by TypeScript.
