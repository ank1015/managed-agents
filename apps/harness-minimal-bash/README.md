# Minimal bash Worker

Hosts one SQLite `MinimalBashSessionV7` Durable Object per `minimal-bash/v7` session. The [harness package](../../packages/harness-minimal-bash/README.md) defines config, history, steering, serial bash and graceful cancellation. This app supplies the driver, private operation-worker bindings and D1 status publication. It has no public callback or session HTTP endpoint. `GET /health` returns `{ "ok": true, "harness": { "id": "minimal-bash", "version": "v7" } }` if invoked through a configured route/binding. V7 is **deployed on 2026-09-20**; see the [deployment record](../../DEPLOYMENT.md).

## Create and use a session

Through authenticated agent-api, `POST /v1/sessions`:

```json
{
  "requestId": "create-coding-session-1",
  "harness": { "id": "minimal-bash", "version": "v7" },
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
    message: LlmMessage; // full conversational message; no generated lifecycle entries
    inContext: boolean;
    runId: string | null;
    responseMetadata: JsonValue | null;
  }>;
  nextCursor: number | null;
  state: {
    status: "idle" | "running" | "cancelling" | "cancelled" | "failed" | "waiting"; // D1 display status, added by API
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

- `MINIMAL_BASH_SESSIONS`: this app's SQLite namespace, pinned by agent-api's `minimal-bash-v7` route.
- `LLM`: private `LlmGateway` entrypoint on `managed-agents-llm-gateway`.
- `BASH`: private `PiBash` entrypoint on `managed-agents-tool-pi-bash`.
- `SESSION_DIRECTORY`: the same D1 directory used by agent-api, not R2.

The host chooses return routes; model inputs cannot choose callback destinations. Both operation workers have the matching namespace binding and `SESSION_ROUTES` mapping. The deployed stateless shared execution callback worker forwards signed v3 inline results to bash, which admits normalized outcomes into this session before the gateway receives 204. Bash/router D1, Queue and cron bindings are removed, and the execution user is configured for v3. The LLM Worker likewise uses gateway `clientContext` and signed schema-v2 inline results, acknowledging only after durable DO admission. Neither callback path fetches gateway results. Gateway retries own accepted-job delivery recovery; no operation-adapter D1/Queue/cron remains. See the [deployment guide](../../DEPLOYMENT.md).

The driver plans read-only, submits operations with stable IDs, then commits local changes and small acceptance receipts atomically. It owns inbox alarms/retries but never polls accepted jobs. There is no request outbox or historical outcome ledger.

The harness explicitly selects display status on lifecycle transitions. After commit, the host queues D1 writes in an in-memory promise chain, using `waitUntil` without blocking execution. Publication failure is logged and does not roll back work. There is no persisted status/revision state, retry or status cron. A failed/lost update can leave D1 stale until a later explicit transition; ordering is only guaranteed within one activation. Transcript reads return DO execution state with display status added by agent-api from its D1 routing read. `processingBlocked` remains diagnostic and does not rewrite display status to failed.

Initialization creates resolved config and the local phase row only: no alarm, processing kick, D1 publication, operation or system-message insert. The API sets the initial idle status when initialization returns. The code constructs instructions for each LLM request instead of storing the prompt in history. Input/completion recovery alarms remain; accepted jobs alone no longer schedule DO alarms. Gateway retries own delivery for both stateless LLM and bash. Exhausted gateway retries can leave a session waiting until operator redelivery.

## Setup and rollout

No deployment, gateway account creation or remote migration is performed by tests/builds.

**V7 is deployed on 2026-09-20.** The following is the repeatable rollout procedure. It changes fixed SQLite schemas to reduce row/index writes. Pause new traffic and drain **all v6 jobs and callback deliveries** before switching. Old sessions cannot resume through the v7-only registry. Retire directory rows only as a separately approved operation; use fresh creation request IDs for v7. Establish the v7 namespace with `wrangler.bootstrap.jsonc`, deploy LLM/bash with v7 completion bindings, deploy the full v7 host, then switch agent-api and restore traffic. Do not overwrite/delete old namespaces or redirect old callbacks to v7. Preserve existing callback URLs, secrets and payload protocols; no gateway or execution callback router change is needed. See [deployment and verification](../../DEPLOYMENT.md).

1. Configure the [LLM worker](../llm-gateway-workers/README.md), [bash worker](../tool-pi-bash-workers/README.md#deployment-and-breaking-rollout) and [execution callback worker](../execution-gateway-callback-workers/README.md): real URLs, dedicated gateway users/API keys, signing secrets and callback origin allowlists. Neither operation adapter nor callback router needs D1 or Queues; directory D1 remains. LLM requires persisted per-job `clientContext` echoed in signed schema-v2 callbacks and job detail, with terminal response/error included in every callback and redelivery. Execution requires protocol-4 gateway/daemon, callback payload version 3 with inline result/error and full echoed `clientContext` and a reachable machine with bash.
2. Provision a fresh session-directory D1 database for a breaking directory-schema change and set its ID in this app, its bootstrap config and agent-api. Apply `apps/agent-api/migrations/0001_initial.sql` there. The checked-in IDs now identify the fresh v2 database deployed on 2026-09-19; see [deployment records](../../DEPLOYMENT.md). The old v1 database remains intact. Rerunning an edited 0001 against an already-migrated database does not update it.
3. Establish the new `managed-agents-harness-minimal-bash-v7` Worker / `MinimalBashSessionV7` namespace and named operation entrypoints before activating final bindings. First deployment has a cycle (host → operation workers → host namespace); use the bootstrap configuration, then deploy complete configurations. Keep traffic off until all resources and bindings exist. Never update a versioned namespace with new schema/code. Drain the previous version's work before switching callback destinations; v7 requires no new D1 migration and retains the v2 directory database.
4. Deploy final host and operation/callback configurations, then agent-api with `MINIMAL_BASH_SESSIONS`. The host needs no public URL or provider secrets. Restrict service/DO bindings to trusted Workers; API bearer auth represents a trusted backend, not end-user machine authorization.
5. Exercise a real LLM → bash → LLM request and verify durable callback receipts, both gateways' delivery status, transcript and listed status before enabling workloads. Neither adapter has a local delivery ledger. Local tests do not verify actual account permissions, machine connectivity or live providers.

`pnpm dev` starts only agent-api; its bound Workers must be run separately. This harness can be exercised without accounts using its local integration tests. Live multi-worker development additionally requires the resources and callback connectivity above; starting this app alone is not an end-to-end stack.

```sh
pnpm --filter @managed-agents/app-harness-minimal-bash check
pnpm check
```

Checks include strict TypeScript, Miniflare/workerd integration tests, a real SQLite row-write regression measurement and a Wrangler **dry-run** bundle. Fixtures are excluded from production bundles. See the package's [bounds and remaining work](../../packages/harness-minimal-bash/README.md#bounds-and-remaining-work) before deployment.

Outgoing operation inputs allow 8 MiB; outcomes and individual message rows allow 1,900,000 UTF-8 JSON bytes. Inbox and harness storage are inline only: no chunk tables, manifests or chunk package. Full-worker tests cover a large inline native response and an oversized result that delivers a small failure, marks the harness failed, and executes no tools. There is no in-place SQL migration engine, token estimate or compaction. The 64 KiB public API-body cap remains unchanged.
