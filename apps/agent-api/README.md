# Agent API

Authenticated backend access to minimal-bash and Pi no-compaction sessions. The API owns authentication, authoritative D1 session routing and creation recovery. Session objects own input admission, transactions, operations and alarms. The API imports shared contracts, never a harness implementation or the session runtime.

V7 is **deployed on 2026-09-20**; source/configurations and examples below target the live v7 SQLite optimization release. See the [deployment guide](../../DEPLOYMENT.md), [deployment guide](../../DEPLOYMENT.md) and [coordinated rollout](../harness-minimal-bash/README.md#setup-and-rollout). No deployment is performed by checks.

## Authentication

Backend requests use one authentication header:

```http
Authorization: Bearer <BACKEND_TOKEN>
```

The token identifies one trusted backend and must not be shipped to a browser.

Set `BACKEND_TOKEN` as a Worker secret. Missing configuration fails closed with 503; invalid credentials return 401. Unknown sessions return 404. `/health` is a public liveness endpoint and does not query dependencies.

This milestone intentionally has no end-user login, key-management database, roles, or user-facing API keys. Token rotation is a coordinated secret update; overlapping credentials can be added if needed.

## Run it

From the repository root:

```sh
pnpm install
pnpm check
```

The integration tests run an ephemeral local stack with fake operation workers; no account is needed.

For a persistent local HTTP server:

1. Copy `apps/agent-api/.dev.vars.example` to `apps/agent-api/.dev.vars` and configure the backend token.
2. Apply the directory migration and start the Workers:

```sh
pnpm --filter @managed-agents/agent-api db:migrate:local
pnpm dev
```

`pnpm dev` starts only agent-api. Run the minimal-bash host and its operation workers separately with configured bindings and gateway credentials for a live session; see the host setup instructions.

## Public contract

All JSON request bodies need `Content-Type: application/json` and are limited to 64 KiB. Responses are `Cache-Control: no-store`. Errors use `{ "error": { "code": "...", "message": "..." } }`. Unknown body fields and invalid/repeated query parameters are rejected.

| Method and route | Result |
|---|---|
| `POST /v1/sessions` | 201 for a new reservation, 200 for successful retry; `{session, duplicate}` |
| `GET /v1/sessions` | All session records with their harness, metadata and status |
| `POST /v1/sessions/:id/inputs` | 202 after durable acceptance; input receipt |
| `GET /v1/sessions/:id/messages?after=0&limit=100` | Minimal-bash transcript page and current state |
| `GET /v1/sessions/:id/pending-messages?after=0&limit=100` | Minimal-bash pending steering page and current state |
| `GET /health` | Public liveness check |

Create a session:

```json
{
  "requestId": "create-agent-123",
  "harness": { "id": "minimal-bash", "version": "v7" },
  "config": { "provider": "openai", "modelId": "gpt-5.6-sol", "accountId": "11111111-1111-4111-8111-111111111111", "machineId": "22222222-2222-4222-8222-222222222222", "cwd": "/workspace" },
  "metadata": { "title": "My coding session", "source": "example" }
}
```

`requestId` is required, nonempty, globally scoped and at most 200 characters. `metadata` is a required JSON object. The source registry contains `minimal-bash/v7` and `pi-no-compaction/v1`. The Pi harness is deployed; see its [configuration](../../packages/harness-pi-no-compaction/README.md) and [production verification](../../PI_NO_COMPACTION_PRODUCTION_TEST.md). Session IDs are opaque `ses_<UUID>` strings. The object's name is the complete public ID within its pinned namespace. See the [minimal-bash config, inputs and read contracts](../harness-minimal-bash/README.md#create-and-use-a-session) for coding sessions.

The list response is `{ "sessions": [{ "sessionId": "ses_<UUID>", "harness": { "id": "minimal-bash", "version": "v7" }, "metadata": { "source": "example" }, "status": "idle" }] }`. Status is one of `initializing`, `initialization_failed`, `idle`, `running`, `failed`, `cancelling`, `cancelled`, `waiting`, or `destroyed`. Creation starts at `initializing`; after DO initialization the API marks it `idle`. Invalid config becomes `initialization_failed`, distinct from a failed run. `destroyed` is reserved for retirement; there is no destroy endpoint yet.

Submit an input using the returned session ID:

```json
{
  "eventId": "message-1",
  "event": { "type": "minimal_bash.message", "payload": { "message": { "role": "user", "content": [{ "type": "text", "text": "Hello" }] } } }
}
```

A receipt contains `sessionId`, `eventId`, inbox `sequence`, `receivedAt`, and `duplicate`. Retrying identical content with the same event ID returns the original receipt with `duplicate: true`. Changed content returns 409. A 202 means admission, not successful processing. Reserved `runtime.*` event types and `runtime:` IDs are rejected.

For both harnesses, the harness explicitly selects running/cancelling/cancelled/failed/idle on lifecycle transitions. Its host writes D1 after local commit, without awaiting publication on the execution path. There are no stored status revisions, inferred statuses or scheduled repair. A failed/lost write may leave display status stale until a later explicit transition. Message pages combine current DO execution state with display `state.status` from the existing D1 routing read; these are not an atomic snapshot. Pagination defaults to `after=0`, `limit=100`; `after` must be a nonnegative integer and `limit` 1–100. Pages may contain fewer rows due to the message-byte budget.

Generic outputs, operation inspection, processing progress, session-info GET, operator runtime run/resume and fixture controls remain unexposed. Minimal-bash cancellation/resume are harness input events, not new administrative endpoints. No output-event store or stream is reintroduced.

## Creation and routing correctness

The `sessions` table is the authoritative directory. Fields are `session_id`, `harness_json`, `metadata_json`, `status`, `creation_request_id` (unique), `creation_request_hash` (canonical SHA-256), `route_key`, `created_at`, `ready_at`, and `error_json`. No full creation payload/config, separate creation state, status revision or refresh timestamp is retained. The complete D1 schema is in the single fresh-database migration `0001_initial.sql`; there is no old-schema compatibility. All request-scoped directory sessions start with `first-primary`.

Creation proceeds as:

```text
reserve identity, hash and route in D1 with status initializing
  → idempotently initialize local DO state (no alarm, processing kick or D1 write)
  → API conditionally changes initializing to idle
  → return the session
```

Any uncertain failure returns 503 with `Retry-After: 1`. Retrying the **same requestId and original content** resumes progress using the reserved session ID, including after a process restart. JSON object key order does not matter. Content conflicts return 409. Invalid harness config is stored as a stable failure; corrected content needs a new request ID. The key remains reserved without an expiry in this milestone. There is no cross-store transaction and no scheduled creation sweeper: abandoned creations remain reserved until the backend retries.

Inputs and transcript reads reject `initializing`, `initialization_failed` and `destroyed` with 409 `SESSION_NOT_READY`. Other statuses do not control execution/admission: the harness's own state machine does. Duplicate creation never resets an already-running session to idle. On a new reservation the successful path uses a lookup, `INSERT ... RETURNING`, DO initialization, then the conditional D1 update; no post-insert reread is needed except when another concurrent request won the reservation.

The route registry contains deployment metadata only. Each harness version owns a fixed namespace/schema. Each new harness/version gets a new Worker/class/namespace while keeping the existing D1 schema/database. The new `pi-no-compaction/v1` route adds a separate namespace alongside `minimal-bash/v7`. Input and transcript routing select only `route_key` and `status`, not the full directory row. After the v7 cutover, earlier-version sessions cannot resume through the current route registry. Directory listing still returns retained older rows; it does not rewrite their harness versions or migrate sessions.

## Harness routing

The harness host exposes `sessionRequest(unknown): Promise<SessionReply<unknown>>` using structured RPC arguments/results. Typed commands and success/error envelopes live in `packages/contracts`; no manual JSON wrapping is needed. HTTP checks syntax/size, command dispatch checks the envelope, and the DO admission boundary validates the submitted input once before its asynchronous lock. Expected errors use explicit data envelopes so HTTP status mapping does not depend on custom exception prototypes surviving RPC. Unexpected failures remain retryable 503s. Operation workers return completions directly to the pinned namespace, not through agent-api.

## Verification

`test/api.test.ts` runs the actual Workers with D1 and separate SQLite namespaces. It covers session listing; concurrent and conflicting creation; invalid config; interruption before/after initialization across restarts; lost create/input responses; invalid auth; removed public routes; reserved inputs; durable acceptance; recovery after restart; malformed HTTP and body limits; and missing-secret behavior.

Creation fault injection exists only in the test host. Production bundles contain no fault switches. Runtime tests independently cover operation recovery and rollback.

`apps/harness-minimal-bash/test` also runs this API with the real coding host, D1 status projection, restart/cancellation tests, and a full production operation-worker/callback/Queue path against fake upstream gateways.

## Cloud setup

The production resources are provisioned in APAC. `managed-agents-agent-api` is available at `https://managed-agents-api.acentric.dev`. The harness host has no public session routes. The breaking v2 deployment applied this squashed migration to a fresh directory; checked-in IDs identify that new database and the old database is retained separately. See [deployment records](../../DEPLOYMENT.md). For a future breaking change, provision a replacement deliberately; never assume rerunning an edited migration resets a database.

1. Apply `0001_initial.sql` with `wrangler d1 migrations apply SESSION_DIRECTORY --remote` before deploying code that requires it. A database that already applied an earlier version of 0001 will not acquire the new status fields by rerunning that command. Deliberately recreate/migrate it first; this implementation does not reset any database.
2. Deploy harness Workers before agent-api when introducing a new namespace binding.
3. `BACKEND_TOKEN` is an agent-api Worker secret.

For first-time minimal-bash deployment, follow its [binding-cycle and gateway setup instructions](../harness-minimal-bash/README.md#setup-and-rollout). `pnpm check` validates the harness host, operation workers and the API using local tests and dry-run builds, not deployments.
