# Agent API

Authenticated backend access to minimal-bash sessions. The API owns authentication, authoritative D1 session routing and creation recovery. Session objects own input admission, transactions, operations and alarms. The API imports shared contracts, never a harness implementation or the session runtime.

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
  "harness": { "id": "minimal-bash", "version": "v1" },
  "config": { "provider": "openai", "modelId": "gpt-5.6-sol", "accountId": "11111111-1111-4111-8111-111111111111", "machineId": "22222222-2222-4222-8222-222222222222", "cwd": "/workspace" },
  "metadata": { "title": "My coding session", "source": "example" }
}
```

`requestId` is required, nonempty, globally scoped and at most 200 characters. `metadata` is a required JSON object. The only registered harness is `minimal-bash/v1`. Session IDs are opaque `ses_<UUID>` strings. The object's name is the complete public ID within its pinned namespace. See the [minimal-bash config, inputs and read contracts](../harness-minimal-bash/README.md#create-and-use-a-session) for coding sessions.

The list response is `{ "sessions": [{ "sessionId": "ses_<UUID>", "harness": { "id": "minimal-bash", "version": "v1" }, "metadata": { "source": "example" }, "status": "idle" }] }`. Status is one of `idle`, `running`, `failed`, `cancelling`, `cancelled`, or `waiting`. Creation starts at `idle`; a definitive creation failure changes it to `failed`.

Submit an input using the returned session ID:

```json
{
  "eventId": "message-1",
  "event": { "type": "minimal_bash.message", "payload": { "message": { "role": "user", "content": [{ "type": "text", "text": "Hello" }] } } }
}
```

A receipt contains `sessionId`, `eventId`, inbox `sequence`, `receivedAt`, and `duplicate`. Retrying identical content with the same event ID returns the original receipt with `duplicate: true`. Changed content returns 409. A 202 means admission, not successful processing. Reserved `runtime.*` event types and `runtime:` IDs are rejected.

For minimal-bash, running/cancelling/cancelled/failed/idle status is projected from the session object into D1, with revision guards and scheduled repair. Listings are eventually consistent; message reads return current object state. The message endpoints are available only for minimal-bash and return 404 for other harnesses. Pagination defaults to `after=0`, `limit=100`; `after` must be a nonnegative integer and `limit` 1–100. Pages may contain fewer rows due to the message-byte budget.

Generic outputs, operation inspection, processing progress, session-info GET, operator runtime run/resume and fixture controls remain unexposed. Minimal-bash cancellation/resume are harness input events, not new administrative endpoints. No output-event store or stream is reintroduced.

## Creation and routing correctness

The `sessions` table is the authoritative directory. The globally unique `creation_request_id` reserves a single session under concurrent retries. Each row stores its public session ID, harness JSON, metadata JSON and status, plus internal creation/routing data and status revision/refresh fields. The complete D1 schema is defined by the single fresh-database migration `0001_initial.sql`; there are no compatibility migrations for older schemas. All request-scoped directory sessions start with `first-primary` so routing reads do not depend on a stale replica. [D1 Sessions consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/)

Creation proceeds as:

```text
reserve identity and route in D1
  → idempotently initialize the selected object
  → mark D1 ready
  → return the session
```

Any uncertain failure returns 503 with `Retry-After: 1`. Retrying the **same requestId and original content** resumes progress using the reserved session ID, including after a process restart. JSON object key order does not matter. Content conflicts return 409. Invalid harness config is stored as a stable failure; corrected content needs a new request ID. The key remains reserved without an expiry in this milestone. There is no cross-store transaction and no scheduled creation sweeper: abandoned creations remain reserved until the backend retries.

The input endpoint requires a ready directory entry; otherwise it returns 409 `SESSION_NOT_READY`. The route registry contains deployment metadata only. Keep route keys and existing namespace bindings stable while sessions reference them.

## Harness routing

The harness host exposes a `sessionRequest(string): Promise<string>` binding protocol. Typed commands and success/error envelopes live in `packages/contracts`. Expected errors are explicitly serialized so HTTP status mapping does not depend on custom exception prototypes surviving Worker RPC. Unexpected failures remain retryable 503s. Minimal-bash additionally binds the existing LLM and bash workers; those workers return completions directly to its pinned namespace, not through agent-api.

## Verification

`test/api.test.ts` runs the actual Workers with D1 and separate SQLite namespaces. It covers session listing; concurrent and conflicting creation; invalid config; interruption before/after initialization across restarts; lost create/input responses; invalid auth; removed public routes; reserved inputs; durable acceptance; recovery after restart; malformed HTTP and body limits; and missing-secret behavior.

Creation fault injection exists only in the test host. Production bundles contain no fault switches. Runtime tests independently cover operation recovery and rollback.

`apps/harness-minimal-bash/test` also runs this API with the real coding host, D1 status projection, restart/cancellation tests, and a full production operation-worker/callback/Queue path against fake upstream gateways.

## Cloud setup

The production resources are provisioned in APAC. `managed-agents-agent-api` is available at `https://managed-agents-api.acentric.dev`. The harness host has no public session routes. This squashed migration targets a fresh D1 database; recreate or explicitly replace any database initialized from the older migration history before deploying this contract.

1. Apply `0001_initial.sql` with `wrangler d1 migrations apply SESSION_DIRECTORY --remote` before deploying code that requires it. A database that already applied an earlier version of 0001 will not acquire the new status fields by rerunning that command. Deliberately recreate/migrate it first; this implementation does not reset any database.
2. Deploy harness Workers before agent-api when introducing a new namespace binding.
3. `BACKEND_TOKEN` is an agent-api Worker secret.

For first-time minimal-bash deployment, follow its [binding-cycle and gateway setup instructions](../harness-minimal-bash/README.md#setup-and-rollout). `pnpm check` validates the harness host, operation workers and the API using local tests and dry-run builds, not deployments.
