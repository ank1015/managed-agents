# Minimal bash Worker

> The [deployment record](../../execution/DEPLOYMENT.md) describes the earlier machine-secret release.
> The per-session gateway URL contract requires matching hosts/tools and fresh sessions.

Hosts one SQLite `MinimalBashSessionV7` Durable Object per `minimal-bash/v7` session. The [harness package](../../packages/harness-minimal-bash/README.md) defines config, history, steering, serial bash and graceful cancellation. This app supplies the driver, private operation-worker bindings and D1 status publication. It has no public callback or session HTTP endpoint. `GET /health` returns `{ "ok": true, "harness": { "id": "minimal-bash", "version": "v7" } }` if invoked through a configured route/binding.

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
    "executionGatewayUrl": "https://execution-api.acentric.dev",
    "executionToken": "<machine execution secret for this machine>",
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

The host chooses return routes; model inputs cannot choose callback destinations. Both operation workers have the matching namespace binding and `SESSION_ROUTES` mapping. Execution results arrive from the per-machine gateway through private tool-worker service bindings, then `acceptToolCompletion` admits them durably into this session. The daemon outbox owns retries; neither the gateway nor tool adapters store result jobs or poll for them. LLM callbacks use their own gateway contract. Deploy this breaking machine-secret contract with matching hosts and fresh sessions.

The driver plans read-only, submits operations with stable IDs, then commits local changes and small acceptance receipts atomically. It owns inbox alarms/retries but never polls accepted jobs. There is no request outbox or historical outcome ledger.

The harness explicitly selects display status on lifecycle transitions. After commit, the host queues D1 writes in an in-memory promise chain, using `waitUntil` without blocking execution. Publication failure is logged and does not roll back work. There is no persisted status/revision state, retry or status cron. A failed/lost update can leave D1 stale until a later explicit transition; ordering is only guaranteed within one activation. Transcript reads return DO execution state with display status added by agent-api from its D1 routing read. `processingBlocked` remains diagnostic and does not rewrite display status to failed.

Initialization creates resolved config and the local phase row only: no alarm, processing kick, D1 publication, operation or system-message insert. The API sets the initial idle status when initialization returns. The code constructs instructions for each LLM request instead of storing the prompt in history. Input/completion recovery alarms remain; accepted jobs alone no longer schedule DO alarms. The LLM gateway owns LLM callback retries; the daemon outbox owns execution result retries. Exhausted LLM gateway retries can leave a session waiting until operator redelivery.

## Setup and rollout

No deployment, gateway account creation or remote migration is performed by tests/builds.

The namespace remains `MinimalBashSessionV7`, with the existing directory D1. The
new host-private execution table is created automatically. Follow the coordinated
[execution integration rollout](../../packages/session-execution/README.md#rollout).
Drain operations using the retired execution gateway before the cutover and pause
new sessions until tools, hosts, execution gateway and agent-api have been updated.

Configure the private `PiBash` service binding; sessions supply `config.executionGatewayUrl`. The execution
gateway routes native tool results through `PiBashCallbacks`. The host discovers
and pins the machine runtime before its first tool submission. The old execution callback router
is not part of the Pi path. LLM gateway webhook handling is unchanged.

Create an execution key on the new gateway and pass it to agent-api when creating
a fresh session. Existing sessions from the previous execution contract do not
migrate automatically. Deploy the matching daemon, gateway and tools together;
new session DOs bootstrap the updated host execution table.

`pnpm dev` starts only agent-api; its bound Workers must be run separately. This harness can be exercised without accounts using its local integration tests. Live multi-worker development additionally requires the resources and callback connectivity above; starting this app alone is not an end-to-end stack.

```sh
pnpm --filter @managed-agents/app-harness-minimal-bash check
pnpm check
```

Checks include strict TypeScript, Miniflare/workerd integration tests, a real SQLite row-write regression measurement and a Wrangler **dry-run** bundle. Fixtures are excluded from production bundles. See the package's [bounds and remaining work](../../packages/harness-minimal-bash/README.md#bounds-and-remaining-work) before deployment.

Outgoing operation inputs allow 8 MiB; outcomes and individual message rows allow 1,900,000 UTF-8 JSON bytes. Inbox and harness storage are inline only: no chunk tables, manifests or chunk package. Full-worker tests cover a large inline native response and an oversized result that delivers a small failure, marks the harness failed, and executes no tools. There is no in-place SQL migration engine, token estimate or compaction. The 64 KiB public API-body cap remains unchanged.

## Immutable execution credentials

The harness requires `config.executionGatewayUrl` (an HTTPS origin) and
`config.executionToken` (a machine-bound `me1.…` secret). Both are immutable.
The host supplies the selected origin as `execution.gatewayUrl`; it is not model input.
The host supplies it as `execution.token` to the Pi tools and pins the discovered
runtime before the first tool dispatch. No credential goes into model inputs,
operation payloads, callback context, transcripts or diagnostics.

There is no top-level creation `execution` field or token-update endpoint/RPC.
Gateway rotation does not modify stored configuration: future submissions with
the old token fail, while already accepted callbacks may still complete. Create
a fresh session with the replacement token. This breaking config contract has
been verified locally; existing sessions are not migrated.
