# Session runtime

The session engine running inside a Cloudflare SQLite-backed Durable Object. Steps 1 and 2 implement migrations, fixed configuration, durable input admission, one-event transactions, durable operations, provider dispatch/reconciliation, and recovery alarms. Import the public API from `@managed-agents/session-runtime`.

This is a library. The hosting Worker chooses a harness, supplies storage and provider adapters, and exposes the desired methods. The package owns delivery mechanics; the host owns routing, authentication, HTTP protocol adapters, and deployment configuration.

Use **`SessionDriver` for automatically progressing sessions**. `SessionRuntime` remains the synchronous transaction core, useful for manual diagnostics and tests. Do not create a second core or mutate its storage alongside a production driver: all admissions must go through the driver's alarm coordination.

## Hosting the Step 2 driver

```ts
import { SessionDriver } from "@managed-agents/session-runtime";

// In a SQLite-backed Durable Object's constructor:
this.driver = new SessionDriver(ctx.storage, harness, {
  providers: { echo: echoProvider }, // Implements OperationProvider; deployment-owned auth/transport.
  waitUntil: promise => ctx.waitUntil(promise),
});

// Forward the Durable Object's alarm method:
async alarm() { await this.driver.alarm(); }

// Authorized host entrypoints await durable admission, which also requests prompt progress:
await this.driver.initialize({ session: identity, config: {} });
await this.driver.appendInput({ eventId: "user:1", event: { type: "message", payload: "hello" } });
// Authenticate provider callbacks separately before admission:
await this.driver.acceptCompletion(normalizedCallback);
```

Keep one driver per object activation and forward every alarm. Its constructor checks provider configuration and applies schema migrations synchronously without scheduling alarms. The host may use `run()` to explicitly request a bounded progress slice; merely constructing a driver does not invent a wakeup for work previously admitted through the manual core.

| Driver API | Behavior |
|---|---|
| `initialize`, `appendInput`, `acceptCompletion` | Async admission: establish recovery wakeup, commit synchronously, then request prompt progress with `waitUntil`. |
| `alarm()` | Replace the consumed recovery wakeup and run/join a bounded progress slice. |
| `run()` | Process inbox transitions and eligible deliveries/reconciliation; concurrent calls join one loop. |
| `resumeProcessing()` | Clear a blocked/failed input's retry state and retry it; never discard an input. |
| `getSession`, `getOperation` | Synchronous detached reads. Operation info includes provider/type/version, correlation, job handle, outcome, causation/timestamps and `reconcileError`; it never includes the original input. |
| `getProcessingStatus()` | Pending head input, failure count, retry time, blocked flag and last error. |

The async admission methods snapshot validated caller data before awaiting storage. An admission receipt confirms retained work, not completed processing. Admissions remain available while the dispatcher awaits a provider; their transitions run when the active bounded provider request finishes (or times out). Provider submission calls are sequential initially; accepted external jobs can execute concurrently.

## Provider adapters and operation delivery

`OperationProvider` exposes async `submit(submission, signal)` and `get(query, signal)`. The driver injects an abort signal and enforces a timeout even if an adapter ignores it; adapters should propagate the signal to their transport. Configure providers by logical name in `ProviderRegistry`. The harness declares exact `{ provider, type, version }` combinations in `operations`; undeclared requests fail before insertion, and the driver refuses construction if any declared provider lacks an adapter. Adapters connect to implemented operation workers using the contracts DTOs and must honor their durable acceptance/idempotency rules. Worker storage, queues, gateway integration, authentication and session return routing belong outside this package.

The context's `requestOperation` allocates a local UUID and stores provider/type/version in `runtime_operations` and immutable input in `runtime_outbox`, inside the harness transaction. The submission identity is a persisted JSON tuple of session ID, harness ID/version and local operation ID. It is opaque to the provider and stays unchanged on retries. Operation IDs created in uncommitted attempts are discarded. Operation declarations are snapshotted at construction so harness mutations cannot change the active allowlist.

Delivery takes these steps:

1. Select an eligible committed outbox action or reconciliation deadline.
2. In a short transaction, increment its attempt count, assign an attempt token and persist a lease deadline.
3. Await the provider outside any transaction or admission lock.
4. In another short transaction, record acceptance, completion, definitive rejection, or a retry deadline.

An interrupted `submitting` action becomes eligible at its lease deadline. Each new attempt uses the same submission ID but a fresh token; stale responses cannot change a newer attempt's state. Throws, timeouts and malformed responses retry with bounded exponential backoff and jitter. No retry limit turns uncertain provider delivery into fabricated terminal failure. A definitive rejection becomes a submission-origin failed completion.

Acceptance stores the worker job handle, schedules status reconciliation, and deletes the outbox row and its input in one transaction. The worker now owns execution/recovery. Definitive rejection and immediate completion also delete the outbox row. Before acceptance, uncertain delivery retains its input for retries. There is no `delivered` outbox state or retained request snapshot after handoff.

Missing callbacks are recovered via `get`, carrying only operation/submission/job IDs. A `missing` accepted job is recorded as a recovery/contract error and retried through status queries with backoff; it never recreates the outbox or resubmits work. Successful pending status checks reset consecutive reconciliation failure backoff and clear the error. Submission errors stay in the temporary outbox; reconciliation counters/deadlines and the bounded `reconcile_error` remain with the operation and are visible through `OperationInfo.reconcileError`.

Completion admission validates the expected provider, submission ID and any known job handle. The first result commits its outcome and one runtime inbox event together. Identical callbacks return the original receipt; changed correlation/outcomes fail. A callback may establish the job handle before submit returns. Later acknowledgements or errors cannot regress a terminal result. The harness handles the runtime event in a separate transaction; a handler failure does not erase the admitted provider outcome. Callbacks and reconciliation share this completion path.

## Recovery wakeups, budgets and failures

The recovery protocol deliberately establishes an alarm **before** committing newly admitted work. If alarm creation fails, no work is admitted. Interruption before the commit may leave an extra alarm; interruption after it leaves retained work with a wakeup. Each progress slice also establishes a recovery alarm before processing or awaiting external calls. Entering `alarm()` consumes a wakeup, so it re-arms even when joining an already running slice.

A per-instance queue serializes alarm read/set/delete operations with admissions and short local state changes. It is never held across provider I/O. At the end of a slice the driver computes the earliest inbox retry, outbox lease/retry, or reconciliation deadline and updates the single alarm while holding that same queue. If there is no runnable or scheduled work, it clears the alarm. A concurrent admission therefore cannot be committed between an idle snapshot and alarm deletion. Failed rescheduling leaves the previously established recovery alarm. Unexpected internal/storage errors reject the background task/alarm; the recovery wakeup and platform alarm retries are the remaining fallback.

`waitUntil` starts processing promptly after admission. Alarms provide recovery and bounded continuations, rather than polling for every user message. The following `policy` overrides are available:

| Policy | Default |
|---|---:|
| `maxSteps` (each step can process one input and one delivery) | 32 |
| `maxSliceMs` (checked between steps) | 250 ms |
| `providerTimeoutMs` | 10,000 ms |
| `attemptLeaseMs` (must exceed provider timeout) | 15,000 ms |
| `recoveryMs` | 30,000 ms |
| `continuationMs` | 1 ms |
| `retryBaseMs` / `retryMaxMs` | 500 / 60,000 ms |
| `reconcileMs` | 30,000 ms |
| `maxHandlerFailures` | 5 |

These are configuration defaults, not latency guarantees. A running synchronous transition cannot be preempted; one provider call can exceed the slice budget up to its timeout. Platform alarm delivery may also be delayed. Finite integer policy values are validated at construction.

A failed handler rolls back first; the driver then records the failed event and backoff outside that transaction. After `maxHandlerFailures`, processing is explicitly blocked on that event. Later inputs and completions are still admitted, and already committed provider work still progresses. A blocked input alone has no retry alarm, avoiding a hot failure loop. Fix the harness and invoke `resumeProcessing()` to retry the retained input. Runtime infrastructure failures are not silently converted into harness success or skipped events.

The runtime does not implement cancellation delivery/policy, real operation workers, public API routing, streaming, large-result storage or history/result pruning. Request input cleanup at handoff is implemented. The success and retry guarantees depend on providers preserving job identity and queryable terminal results; they do not imply exactly-once arbitrary external side effects.

## Using the synchronous core

```ts
import { SessionRuntime } from "@managed-agents/session-runtime";

// In the session Durable Object's constructor, using its chosen harness:
const runtime = new SessionRuntime(ctx.storage, harness);

const initialized = runtime.initialize({
  session: {
    sessionId: "session-123",
    harness: harness.identity,
  },
  config: {}, // The selected harness defines its configuration.
});

const receipt = runtime.appendInput({
  eventId: "producer-event-1",
  event: { type: "message", payload: { text: "Hello" } },
});

const transition = runtime.processNext();
```

The example event and config must be supported by the selected harness. Keep one runtime instance per object. All methods are synchronous. Construction completes schema work before returning; if it throws, the host must not serve requests using that runtime. If the host later adds asynchronous startup, it must gate request delivery until startup completes.

| API | Behavior |
|---|---|
| `new SessionRuntime(storage, harness)` | Validate and apply migrations, check an existing session's harness identity. Does not initialize a session or process inputs. |
| `initialize(unknown)` | Return `{ session, duplicate }`; atomically create metadata and harness initial state. |
| `appendInput(unknown)` | Return an `InputReceipt`; persist a newly validated event or recover the original receipt. Does not invoke `handle`. |
| `processNext()` | Handle the oldest pending event in one transaction. Return `{ processed: true, eventId, sequence }` or `{ processed: false }`. Throw on failure. |
| `getSession()` | Return a detached `SessionInfo` with persisted normalized config. |
| `acceptCompletion(unknown)` | Atomically retain an authenticated normalized provider result and completion input. No automatic processing. |
| `getOperation(id)` | Return detached operation info or throw `OPERATION_NOT_FOUND`. |

Except for initialization, session methods require an initialized session and otherwise throw `SESSION_NOT_INITIALIZED`. Boundary requests are validated using the contracts package. `getSession()` exposes JSON configuration; typed configuration is provided to the selected harness's context.

`RuntimeStorage` is a `Pick` of Cloudflare's `DurableObjectStorage`, containing `sql` and `transactionSync`. It is not an alternative database implementation. The runtime relies on Cloudflare's transaction and response/output-gate behavior. A synchronous method result inside the object is not a separate network delivery acknowledgement; return it through the normal Durable Object response path.

## Initialization and configuration

The runtime stores both the original JSON config request and the validated/defaulted JSON config. A retry must match the original identity and original config structurally; object key order does not matter. Supplying explicit defaults where the original request omitted them is a conflicting request, even if both would normalize to the same config.

Matching retries return the saved config and creation time without calling `parseConfig` or `initialize` again. Conflicting session identity, harness, or original config throws `INITIALIZATION_CONFLICT`. The runtime checks the hosting harness's ID and version both when opening an existing session and when initializing.

For a new session, `parseConfig` receives a detached copy. Its result must be synchronous and JSON-compatible. Metadata and initialization writes share one transaction. A thrown exception or non-`undefined` initialization result rolls them back. Completed schema migrations remain; initialization can retry against those tables.

The saved config is loaded for every invocation without rerunning defaults or validation. Compatible harness releases must understand the stored normalized config. Configuration changes are not part of this API.

## Admission and transitions

Event IDs are unique within a session. Retries compare the full event body structurally before calling the harness parser. An identical pending or consumed event returns its original sequence and admission time with `duplicate: true`; a changed body throws `INPUT_CONFLICT`.

For new IDs, `parseInput` validates a detached event and must preserve its content. Rewriting either its argument or returned value is rejected. Sequence allocation and insertion occur atomically, so rejected inputs do not consume sequence numbers. Already admitted events are not revalidated during processing; compatible deployments must continue to handle them.

Each `processNext()` transaction:

1. Loads the saved session and lowest pending input sequence.
2. Creates an invocation-scoped context and invokes the synchronous handler.
3. Records harness SQL writes and operation requests inside that transaction.
4. Requires an `undefined` handler result and marks the input consumed.
5. Commits everything together, or rolls everything back if any step throws.

A failure keeps the input pending, including when the handler succeeded but the consumption write failed. Earlier committed transitions remain. The runtime never skips a failing input: later inputs remain pending until the failure is resolved. Handler execution can retry; only successful transition effects commit once. In-memory harness mutations are not rolled back by SQLite and must not be authoritative state.

The manual core may call `processNext()` in a bounded loop. Each call owns a separate transaction. Its methods alone do not schedule alarms or dispatch work; automatic progress belongs to `SessionDriver` above.

## Context

The context includes detached, deeply frozen session identity and configuration, a scoped `sql.exec`, and `requestOperation`. The admitted input envelope passed to `handle` is also frozen. SQL access and operation requests expire when the hook returns or throws. Calls retained for later use fail, and reentrant calls into the runtime are rejected.

Harness code is trusted. It must use only its own tables, fully consume cursors synchronously, and never retain contexts/cursors, take transaction ownership, schedule later work, or perform external I/O during a transition. The wrapper does not sandbox raw SQL or revoke already returned SQL cursors. Detecting a returned promise cannot cancel external work an incorrectly written hook already started. Type-level restrictions, runtime checks, and harness discipline work together.

## Storage and migrations

Operation inputs and complete outcomes are limited separately to 8 MiB of UTF-8 JSON by the shared contract parsers before persistence. The [sqlite-json helper](../sqlite-json/README.md) keeps values up to 256 KiB inline and stores larger values in ordered chunk rows; the owning field holds a small manifest. The same mechanism covers completion inbox events. Row writes, chunk writes, input consumption and request-chunk cleanup share existing synchronous transactions. Failed commits leave no orphan chunks or partial cleanup. The LLM worker converts oversized upstream results into an explicit failure containing the gateway job ID rather than truncating them. There are no R2 payload references.

| Table | Owned data |
|---|---|
| `runtime_migrations` | Separate `runtime` and `harness` histories, versions, exact serialized SQL statement lists. |
| `runtime_session` | Singleton identity, original/normalized config, creation time, last input sequence. |
| `runtime_inbox` | Unique event IDs, admission order/time, original event bodies, nullable consumption time. |
| `runtime_operations` | Provider/type/version, submission identities, worker job handles, terminal outcomes, completion correlation, reconciliation deadlines/tokens/error. No request input. |
| `runtime_outbox` | Temporary immutable `input_json`, submission state (`pending`, `submitting`), attempt counts/tokens, retry/lease deadline and latest submission error. Deleted on acceptance or terminal outcome. |
| `runtime_json_chunks` | Ordered large-payload chunks for outbox input, outcomes and inbox events; each owning field has its own manifest. Request chunks are deleted together with the outbox. Outcomes and consumed inbox chunks remain retained. |
| `runtime_progress` | Failed head input, consecutive attempts, retry deadline and explicit blocked state. |

Runtime migration 3 adds the chunk table without changing previous migration SQL. Existing inline JSON remains readable; new `_json` field values can be either JSON or an internal manifest and must be read through the helper, never SQL JSON functions blindly. Harnesses persisting large operation results must use their own chunk table too; minimal-bash migration 2 implements this for native transcript/metadata and pending messages. No reset of existing session databases is needed for these additive migrations.

The runtime reserves the `runtime_` table/index prefix, external event types beginning `runtime.` and event IDs beginning `runtime:`. The inbox has a partial index on pending input sequence; operations/outbox index their deadlines. Consumed inputs and completed operations remain available for deduplication; there is no pruning or retention policy yet. Counters store the last allocated sequence, initially zero, so allocation can include the largest safe integer without persisting an unsafe successor.

This is a breaking schema/contract revision: runtime migration 2 defines the new tables directly, with no upgrade path from the former retained-request schema. Existing databases with that migration history are rejected; use fresh session databases. Harness definitions must supply `operations`, and operation reads no longer return `request`. Harness input types include `RuntimeEvent`; harnesses must handle or explicitly reject that branch before accessing their own payloads.

The migration history table bootstraps itself. Both migration definitions and both existing histories are checked before applying new migrations. Applied definitions must remain an unchanged prefix: editing SQL (including whitespace), removing versions, inserting versions before already applied migrations, and opening with an older migration list fail closed. New versions can have gaps but must be strictly increasing.

Each migration and its history row share one transaction. If a migration fails, earlier successful migrations remain; its own schema/data changes and history row roll back. The same constructor can be retried after repairing an unapplied migration. Initialized sessions reject a different harness before running its pending harness migrations. An uninitialized database is still tied to the selected deployment and must not be reused for another harness.

SQL migrations belong to this library and the harness. They are separate from Cloudflare class/namespace deployment migrations. Put session-specific initial state in the harness's `initialize` hook, not schema migrations.

## Files and checks

`src/runtime.ts` owns the public lifecycle and transaction boundaries. `context.ts` builds scoped capabilities, `migrations.ts` applies histories, and `storage/` contains runtime schema and SQL operations. Internal helpers are not exported from the package entry point.

```sh
pnpm --filter @managed-agents/session-runtime check
pnpm check
```

Tests bundle the fixtures with esbuild and run them in Miniflare/workerd with SQLite-backed Durable Objects. Fixtures expose SQL and deliberately broken behaviors solely for tests; they must not be deployed. `operations-fixture.ts` also runs a provider in a separate Durable Object/database so its jobs survive session interruption. Restart tests dispose the entire local runtime and reopen temporary persisted databases. `driver.test.ts` uses real Node SQLite plus controllable async alarm methods to interrupt precise admission/commit/reschedule boundaries. No Cloudflare account or cloud deployment is required.

Coverage includes initialization conflicts/rollback, migrations and history drift, ordered admission, retries before/after consumption, concurrent deliveries, invalid validators, transition rollback, consumption-write failure, sequence overflow, scoped context expiry, object isolation, and process restart. Dependency versions are pinned; workspace build permissions cover esbuild and workerd's binary installation scripts.

Operation tests cover declaration/configuration validation, operation rollback/context expiry, atomic acceptance/input deletion, completion atomicity, reserved events, conflicting/duplicate callbacks after cleanup, early callbacks, lost acceptance responses, stale attempt tokens, provider timeouts, delayed/missing callbacks, missing accepted jobs without resubmission, reconciliation failures, concurrent input, bounded continuations, blocked processing/resume, pre-commit alarm failure, interrupted rescheduling and full process recovery before and after request cleanup with one durable provider job.

This package retains its smaller fault-injection fixtures for precise runtime boundary checks. The [LLM operation worker](../../apps/llm-gateway-workers/README.md) implements gateway submission, polling and durable callback delivery. The [minimal-bash harness](../harness-minimal-bash/README.md) and [host](../../apps/harness-minimal-bash/README.md) implement the coding loop, steering, graceful turn-boundary cancellation and D1 status projection on top of this unchanged runtime. Hard operation cancellation remains unimplemented.

Platform references: [SQLite storage and transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [alarms and retry semantics](https://developers.cloudflare.com/durable-objects/api/alarms/), [Miniflare configuration](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare#readme).
