# Harness API

The in-process contract between a trusted harness and the replay-based session runtime. Import from `@managed-agents/harness-api`.

## Definition

`HarnessDefinition<Config, Input, Changes>` supplies:

- `identity` and `schema`: immutable harness-version identity and fixed SQL bootstrap statements.
- `operations`: exact supported `{ provider, type, version }` combinations.
- `parseConfig`: synchronous validation/defaulting; only its resolved JSON result is persisted.
- `parseInput`: synchronous, state-independent validation preserving external event content.
- `initialize(ctx)`: synchronous local initial writes; returns `undefined`.
- `handle(input, ctx)`: synchronous **read-only deterministic planning**.
- `apply(changes, ctx)`: synchronous local writes inside the runtime's commit transaction; returns `undefined`.

`handle` returns:

```ts
interface TransitionPlan<Changes> {
  changes: Changes; // JSON-compatible, in-memory only
  operations: readonly (OperationRequest & { key: string })[];
  status?: HarnessStatus;
}
```

Zero, one, or many outgoing operations are supported. They are independent, not sequential steps: array order does not imply execution/completion order. Return dependent work from a later completion handler instead.

## Planning and applying

`HarnessReadContext` exposes frozen session identity/resolved config, single-SELECT `sql.exec`, and pure `operationId(key)`. Reads must use harness-owned committed state, not the changing runtime inbox/retry state. No writes, network calls, clocks, randomness, async hooks, or authoritative mutable module state in planning. Use the admitted input's sequence/time for deterministic identity/time when needed.

Each operation needs a unique, stable key within its transition. The runtime derives its ID from session ID, harness ID/version, input sequence and key. `ctx.operationId(key)` returns that same ID for use in proposed harness state. Distinct keys create distinct operations even for identical requests; retrying the same input/key must reconstruct identical content.

```ts
handle(input, ctx) {
  const operationId = ctx.operationId("first");
  return {
    changes: { operationId, text: input.event.payload.text },
    operations: [{
      key: "first", provider: "echo", type: "echo", version: "v1",
      input: input.event.payload,
    }],
    status: "running",
  };
},
apply(changes, ctx) {
  ctx.sql.exec("INSERT INTO pending(operation_id, text) VALUES (?, ?)",
    changes.operationId, changes.text).toArray();
}
```

This sketch omits the completion branch. Runtime completion inputs have `{ operationId, provider, jobId, outcome }`; `jobId` is null only for a definitive submission rejection. Use a discriminated external input union and handle `runtime.operation.completed` separately. External producers cannot use `runtime.` event types or `runtime:` IDs.

The runtime validates the entire plan before submitting anything. Once every submission is accepted/completed/rejected, it atomically calls `apply`, stores small accepted-job receipts, queues immediate/rejected completions, releases the consumed input, and removes a consumed completion's pending receipt. No plan or outgoing request is persisted. Unknown submission results retain the input for replay with the same IDs. Already accepted external effects cannot be rolled back if a sibling rejects or local commit fails.

`HarnessWriteContext` and `HarnessInitializationContext` expose identity/config and scoped SQL, but no operation dispatcher. `requestOperation` and `setStatus` have been removed. Changes are harness-defined data, not a generic SQL instruction language. `apply` must only write the already-planned decision, never re-decide it from new state.

## Status and boundaries

Optional `plan.status` is explicit display intent. Only after local commit does the host publish it to D1 best-effort. It is not persisted in runtime state or recovered by cron. Creation status/initial idle belong to agent-api. A failed/lost publication can leave D1 stale until a later explicit transition.

Contexts expire on return/throw. Config and input are deeply frozen. The SELECT guard is deliberately restricted, not a SQL sandbox; trusted harness code must not access runtime tables, retain cursors, take transaction ownership, or schedule later work. The runtime cannot cancel external effects an incorrectly written hook already started.

Fixed schema is bootstrapped transactionally once; later activations only check its presence. Any code/schema change affecting replay requires a new harness-version namespace. No migration history or compatibility path exists.

`pnpm --filter @managed-agents/harness-api check` checks the contract, including rejection of async planning/apply hooks. Replay, rollback, batches and recovery are exercised in the runtime and concrete harness tests.
