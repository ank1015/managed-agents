# Minimal bash Worker

Hosts one SQLite `MinimalBashSession` Durable Object per `minimal-bash/v1` session. The [harness package](../../packages/harness-minimal-bash/README.md) defines config, history, steering, serial bash and graceful cancellation. This app supplies the driver, private operation-worker bindings and D1 status publication. It has no public callback or session HTTP endpoint. `GET /health` returns `{ "ok": true, "harness": { "id": "minimal-bash", "version": "v1" } }` if invoked through a configured route/binding.

## Create and use a session

Through authenticated agent-api, `POST /v1/sessions`:

```json
{
  "requestId": "create-coding-session-1",
  "harness": { "id": "minimal-bash", "version": "v1" },
  "config": {
    "provider": "openai",
    "modelId": "gpt-5.6-sol",
    "accountId": "11111111-1111-4111-8111-111111111111",
    "reasoning": "medium",
    "machineId": "22222222-2222-4222-8222-222222222222",
    "cwd": "/workspace/project"
  },
  "metadata": { "title": "My coding session" }
}
```

Replace the UUIDs/path with real gateway resources. Send initial or steering messages to `POST /v1/sessions/:id/inputs`:

```json
{
  "eventId": "message-1",
  "event": {
    "type": "minimal_bash.message",
    "payload": { "message": { "role": "user", "content": [{ "type": "text", "text": "Inspect this repository and explain its tests." }] } }
  }
}
```

Use distinct event IDs for different logical inputs; reuse an ID only for an identical retry. Read `GET /v1/sessions/:id/messages?after=0&limit=100`:

```ts
{
  messages: Array<{
    sequence: number;
    message: LlmMessage; // full message, including custom lifecycle entries
    inContext: boolean;
    runId: string | null;
    responseMetadata: JsonValue | null;
  }>;
  nextCursor: number | null;
  state: {
    status: "idle" | "running" | "cancelling" | "cancelled" | "failed";
    phase: "idle" | "llm" | "bash" | "cancelled" | "failed";
    runId: string | null;
    activeOperationId: string | null;
    turnCount: number;
    cancelRequested: boolean;
    error: JsonValue | null;
    pendingMessageCount: number;
    processingBlocked: boolean;
  };
}
```

`GET /v1/sessions/:id/pending-messages` accepts the same query parameters and returns `{ messages: [{ eventId, inputSequence, message }], nextCursor, state }`. These messages are not in model history yet. `after` is exclusive; `limit` defaults to 100, range 1–100. A byte budget can return fewer rows. Follow `nextCursor` while paging; after reaching the end, poll new transcript entries using the last seen sequence. Pending entries can disappear between reads as they are promoted; that view is not an immutable feed. Neither read endpoint advances processing.

Stop after the current complete model turn by sending this to `/inputs`:

```json
{ "eventId": "cancel-1", "event": { "type": "minimal_bash.cancel", "payload": { "runId": "<state.runId>" } } }
```

Resume a failed/cancelled session with:

```json
{ "eventId": "resume-1", "event": { "type": "minimal_bash.resume", "payload": {} } }
```

Cancelled/failed sessions hold new messages until explicit resume. `processingBlocked: true` instead indicates an unexpected runtime handler failure requiring a code/operator fix; harness resume cannot bypass a blocked inbox.

## Bindings and status

- `MINIMAL_BASH_SESSIONS`: this app's SQLite namespace, pinned by agent-api's `minimal-bash-v1` route.
- `LLM`: private `LlmGateway` entrypoint on `managed-agents-llm-gateway`.
- `BASH`: private `PiBash` entrypoint on `managed-agents-tool-pi-bash`.
- `SESSION_DIRECTORY`: the same D1 directory used by agent-api, not R2.

The host chooses return routes; model inputs cannot choose callback destinations. Both operation workers have the matching namespace binding and `SESSION_ROUTES` mapping. The existing shared execution callback worker routes gateway notifications to bash, which delivers normalized outcomes to this session. The LLM worker owns its own gateway callback.

The driver owns admission, transactions, operation acceptance/deduplication and alarms. Only harness cursor/state is new; no gateway job ledger is duplicated here.

After progress, the host publishes committed status to D1. A persisted SQLite revision guards against stale, overlapping writes. Publication failure does not roll back harness work. A one-minute cron refreshes up to 100 least-recently-checked sessions in batches of 10, repairing failed/lost updates after eviction too. This is an eventual projection, not a cross-store transaction or a one-minute SLA; a large fleet needs greater refresh throughput. Transcript reads obtain authoritative DO state, with runtime blocked state reflected as failed.

## Setup and rollout

No deployment, gateway account creation or remote migration is performed by tests/builds.

1. Configure the [LLM worker](../llm-gateway-workers/README.md), [bash worker](../tool-pi-bash-workers/README.md#deployment) and [execution callback worker](../execution-gateway-callback-workers/README.md): real URLs, dedicated gateway users/API keys, signing secrets, callback origin allowlists, D1 IDs and Queues. Execution requires protocol-4 gateway/daemon, callback payload version 2, echoed `clientContext` and a reachable machine with bash.
2. Use the same session-directory D1 ID in this app and agent-api. The final directory schema remains in `apps/agent-api/migrations/0001_initial.sql`, including status revision/refresh fields. This is a breaking fresh-schema change. A database that applied the old 0001 will **not** update by rerunning migrations; recreate it deliberately or prepare a separately reviewed migration. No database has been reset by this implementation.
3. Establish the host namespace and named operation entrypoints before activating final bindings. First deployment has a cycle (host → operation workers → host namespace); stage it with one side's unused bindings omitted, then deploy complete configurations. Keep traffic off until all resources and bindings exist. Preserve route/namespace identity on subsequent releases.
4. Deploy final host and operation/callback configurations, then agent-api with `MINIMAL_BASH_SESSIONS`. The host needs no public URL or provider secrets. Restrict service/DO bindings to trusted Workers; API bearer auth represents a trusted backend, not end-user machine authorization.
5. Exercise a real LLM → bash → LLM request and verify callback receipts, worker `delivered_at`, transcript and listed status before enabling workloads. Local tests do not verify actual account permissions, machine connectivity or live providers.

`pnpm dev` starts only agent-api; its bound Workers must be run separately. This harness can be exercised without accounts using its local integration tests. Live multi-worker development additionally requires the resources and callback connectivity above; starting this app alone is not an end-to-end stack.

```sh
pnpm --filter @managed-agents/app-harness-minimal-bash check
pnpm check
```

Checks include strict TypeScript, six Miniflare/workerd integration tests and a Wrangler **dry-run** bundle. Fixtures cannot perform external network requests and are excluded from production bundles. See the package's [bounds and remaining work](../../packages/harness-minimal-bash/README.md#bounds-and-remaining-work) before deployment.

Operation payloads now allow 8 MiB each. Runtime migration 3 and minimal-bash migration 2 add chunk tables automatically when a session opens; they do not rewrite existing migrations or reset data. Upgrade the host and operation workers before sending larger payloads. The full-worker test includes a 7 MiB native response, chunked transcript reads, completion delivery and replay in the next LLM request. There is no local context-token estimate or compaction: a terminal provider context-overflow error fails the run. The separate 8 MiB wire cap and 64 KiB public API-body cap remain enforced.
