# Harness API

The in-process contract between a trusted harness and the session runtime (Steps 1 and 2). Import from `@managed-agents/harness-api`.

## Definition

`HarnessDefinition<Config, Input>` supplies:

- `identity`: harness ID and behavior version.
- `migrations`: ordered SQL schema migrations.
- `operations`: exact `{ provider, type, version }` combinations the harness may request; use `[]` when none are needed.
- `parseConfig`: synchronous validation/defaulting of JSON config.
- `parseInput`: synchronous structural validation, preserving event content and independent of current session state.
- `initialize`: initial harness data inside the runtime's initialization transaction.
- `handle`: one admitted external input or runtime event per runtime-owned transaction (`InputEnvelope<Input | RuntimeEvent>`).

`initialize` and `handle` return `undefined`, not `void`, to reject promise-returning functions at compile time. State is written through the context rather than returned. Errors must propagate out of the transaction callback for rollback.

Config is generic to accommodate typed harness interfaces. The runtime must validate the parsed/defaulted result with `parseJsonValue` before persistence; a generic TypeScript parameter does not prove JSON compatibility. The runtime must also validate inputs before admission.

## Context

`HarnessContext<Config>` exposes session identity, readonly config, `sql.exec`, and `requestOperation(request)`. Cloudflare SQL types are imported explicitly so this package does not require consumers to enable a second set of ambient Worker globals. The Cloudflare dependency is type-only at runtime.

SQL access is for harness-owned tables. It does not sandbox those tables from runtime tables. Harness code is trusted; it must not retain contexts/cursors, schedule later writes, mutate configuration, invoke external services, or take transaction ownership. Fully consume SQL cursors during the invocation.

The interface's `readonly` is shallow; the [session runtime](../session-runtime/README.md) additionally deep-freezes detached config and identity and expires context access after each invocation. Database rollback does not reverse changes to other JavaScript objects.

`requestOperation({ provider, type, version, input })` synchronously returns a new local operation ID. It records operation metadata and an outbox entry containing the immutable input in the current transaction. Save the ID alongside harness-owned context before returning. A throw rolls back the operation, outbox, harness writes, and input consumption together. Generated IDs from rolled-back attempts need not be reused; no provider may observe those attempts. Calls after the context expires fail. The runtime deletes the outbox input after durable acceptance or a terminal result; the harness must retain any context it needs to interpret completion in its own tables.

Declare every supported combination on the harness definition, for example `operations: [{ provider: "echo", type: "echo", version: "v1" }]`. Declarations are validated and snapshotted when the runtime is constructed. Undeclared requests fail synchronously with `INVALID_REQUEST`; duplicate declarations are rejected. The hosting app supplies provider adapters, and the driver refuses to start if a declared provider has no configured adapter. These declarations contain no URLs, bindings, or credentials.

Both `initialize` and `handle` may request operations. Delivery starts after commit through the runtime driver. Harness code never waits for submission and receives no provider client, timer, or retry capability.

The runtime later admits `runtime.operation.completed` with `{ operationId, outcome }`. Handle this branch before reading a payload specific to your external input union:

```ts
handle(input, ctx) {
  if (input.event.type === "runtime.operation.completed") {
    const { operationId, outcome } = input.event.payload;
    ctx.sql.exec("UPDATE pending SET outcome_json = ? WHERE operation_id = ?",
      JSON.stringify(outcome), operationId).toArray();
    return;
  }
  const operationId = ctx.requestOperation({
    provider: "echo", type: "echo", version: "v1", input: input.event.payload,
  });
  ctx.sql.exec("INSERT INTO pending(operation_id) VALUES (?)", operationId).toArray();
}
```

The chosen harness creates `pending` in its migrations. `parseInput` continues to validate only external harness inputs. Runtime events are validated and constructed by the runtime. Use precise discriminated unions for harness input types; a broad `EventBody` type cannot narrow payloads automatically. Never use the reserved `runtime.` event-type or `runtime:` event-ID prefixes for external inputs.

Delivery retries are invisible to the harness. A completion's admission survives a failing completion handler; the pending event retries under the ordinary transition rules. This API does not supply automatic tool cancellation, streaming, or generic harness state management.

## Migrations

`SqlMigration` contains a positive safe-integer version and nonempty SQL statements. `validateMigrations` rejects unordered/duplicate versions and empty statements; versions need not be consecutive, and an empty migration list is valid.

This validates definitions only. The runtime must separately track runtime/harness migration histories, apply each migration and its record atomically, and prevent edits to already-applied migrations. Put session-specific initial rows in `initialize`, not in schema migrations. Invalid migration definitions throw ordinary errors because they are implementation defects, not client validation failures.

## Checks

Run `pnpm --filter @managed-agents/harness-api check` or root `pnpm check`. Runtime tests cover migration validation. Compile-time tests verify real Cloudflare SQL compatibility, typed inputs, readonly config, and rejection of async initialization/handlers. Transaction and process-recovery behavior is tested separately in `packages/session-runtime` against Miniflare/workerd.
