# Shared execution-gateway callback worker

One public callback receiver for the dedicated execution-gateway user. Routes signed terminal-job notifications to private tool worker bindings using the gateway's echoed `clientContext`. This app does not submit gateway jobs, fetch results, format tool output, or contact session Durable Objects. It has no gateway API key or session namespace bindings.

## Contract and ownership

Each tool reserves its own durable gateway-call reference **before** submitting a job, and attaches:

```json
{
  "clientContext": {
    "receiver": "tool-pi-bash-v1",
    "reference": "<stable per-gateway-call reference>"
  }
}
```

For bash the reference is its runtime-generated `submissionId`; a multi-step tool should give each gateway call its own stable reference. The tool worker generates these values, not the model or harness input. The gateway persists the opaque object with the job, includes it in idempotency conflict checks, and echoes it on all terminal callbacks, including pre-execution failure/unknown outcomes.

The gateway accepts arbitrary JSON objects, but this router's convention is deliberately narrower: exactly `receiver` and `reference`. Receiver keys match `[a-z][a-z0-9-]{0,99}`; references are nonempty strings up to 2,048 characters. They are identifiers, not URLs, commands, results or secrets. Do not change them on a submission retry.

The router accepts gateway payload version **2**:

```ts
{
  schemaVersion: 2,
  eventId: string, jobId: string, machineId: string,
  type: "job.succeeded" | "job.failed" | "job.unknown",
  completedAt: string,
  clientContext: { receiver: string, reference: string },
}
```

Shared parsers/types are in `packages/contracts/src/execution-gateway.ts`. Missing context, v1 payloads, extra fields and malformed IDs are rejected. The whole webhook body is capped at 16 KiB. This is not a generic forwarder for arbitrary gateway users or arbitrary destinations: deploy a separate instance/database/queue for each gateway user/environment.

## Admission and durable delivery

1. Verify the gateway's HMAC over the original body, header event ID and timestamp (five-minute freshness window), using the current or optional previous signing secret.
2. Insert the immutable event into D1 before acknowledging HTTP 204. Identical event-ID retries are safe; conflicting content returns 503 and does not replace the original.
3. Route the retained event immediately in `waitUntil`. A failed delivery is queued with backoff; if enqueueing also fails, D1 admission still makes the event recoverable by the scheduled sweep.
4. Resolve `clientContext.receiver` through `CALLBACK_ROUTES`, then invoke only the configured private `acceptGatewayEvent` binding. Never construct an HTTP URL from context or forward old HMAC headers.
5. Require a correlated durable receipt before marking delivery complete. On RPC failure/lost receipt/bad receipt, retain the event and retry with the same identity.

The receiving tool exposes `GatewayEventReceiverBinding`:

```ts
acceptGatewayEvent(serializedEvent: string): Promise<string>
// JSON receipt, only after durable tool-side admission:
{
  status: "accepted",
  eventId: string,
  jobId: string,
  clientContext: { receiver: string, reference: string },
}
```

The receiver must validate its receiver key and correlate reference, machine and any known job ID against its retained reservation. It must durably schedule processing and make repeated admission safe before returning the receipt. A 10-second RPC timeout cannot cancel late admission, so duplicate safety is required. A callback is a wake-up, not authoritative command output: tools still fetch/validate gateway results and deliver their own session completions.

`tool-pi-bash-workers` supplies a separate callback-only `PiBashCallbacks` entrypoint. It atomically binds the job and marks the operation due without a second tool-side event table. The submission/status entrypoint `PiBash` is not exposed to this router.

`migrations/0001_initial.sql` creates only `gateway_callback_events`: event/job/machine/context/type/time, admission/delivery timestamps, retry deadline, attempts, lease token/expiry and last error. It contains no tool/session state or commands/output. No tool has access to this database; the router has no access to tool databases. There is no separate job-to-tool mapping database because routing arrives in the authenticated event.

Leases last 60 seconds and fence stale completions. Retry backoff is bounded at five minutes. Queue is a retry/recovery path (batch size 1, zero batch timeout), and the once-a-minute sweep queues up to 100 due events to recover interrupted work and expired leases after restart. Syntactically valid events for unconfigured receivers are persisted and stay pending with `last_error`; fixing the binding/route allows recovery. Never silently discard them or send them to a default tool. Monitor undelivered count, oldest due time, repeated errors and unknown receivers. No automatic receipt pruning or permanent abandonment policy is implemented yet.

## Adding a tool

Implement the private admission method, then add a stable receiver key and callback-only service binding in this app's Wrangler config:

```jsonc
"vars": { "CALLBACK_ROUTES": "{\"tool-pi-bash-v1\":\"BASH_EVENTS\",\"tool-patch-v1\":\"PATCH_EVENTS\"}" },
"services": [
  { "binding": "BASH_EVENTS", "service": "managed-agents-tool-pi-bash", "entrypoint": "PiBashCallbacks" },
  // Example for a future patch worker; not implemented or configured in this repo yet.
  { "binding": "PATCH_EVENTS", "service": "my-patch-worker", "entrypoint": "PatchCallbacks" }
]
```

Keep old receiver keys mapped while their jobs/events drain. Only grant callback bindings to trusted routers; possession of IDs is not authentication. The service-binding boundary is the tool-side authentication mechanism, and the router is responsible for verifying gateway signatures. Existing tool-side polling remains as an independent recovery path. Session-runtime and agent-api are unchanged.

## Deployment

No resources are provisioned by tests/build. From this directory:

```sh
pnpm exec wrangler d1 create managed-agents-execution-callbacks
pnpm exec wrangler queues create managed-agents-execution-callbacks
# Replace database_id in wrangler.jsonc before migrating.
pnpm exec wrangler d1 migrations apply CALLBACK_DB --remote
pnpm exec wrangler secret put EXECUTION_GATEWAY_WEBHOOK_SECRET
pnpm exec wrangler deploy
```

Before deploying, configure a public HTTPS route/custom domain and the correct tool service names/bindings. Deploy the tool's callback entrypoint first. Configure the execution gateway's dedicated user (admin API or `PATCH /v1/me`) with:

```json
{
  "callbackUrl": "https://<callback-worker-domain>/webhooks/execution-gateway",
  "webhookPayloadVersion": 2
}
```

Allow that exact origin in the gateway's `WEBHOOK_ALLOWED_ORIGINS`. Put the user's webhook signing secret here, not its API key. API keys stay with submitting tool workers. Set optional `EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET` while rotating, then remove it when older signed deliveries drain. Keep any previous callback URL reachable until its captured deliveries drain.

The only HTTP endpoints are `GET /health` (liveness) and `POST /webhooks/execution-gateway`. Preview/worker.dev URLs are disabled by default. Verify a real job reaches both the router's `delivered_at` and the tool/session's completion before production use.

### Breaking rollout

This replaces the bash worker's public webhook, signing-secret settings and `bash_webhook_events` schema; fresh bash databases use the revised initial migration. No live database has been altered, and rerunning an edited initial migration does not upgrade an existing database. If the old worker was deployed, drain outstanding submissions/jobs/callbacks before switching and plan the database cleanup separately—do not reset a database containing active work. Retrying an old job without context using the same idempotency key **with** context is a gateway conflict. Retained old webhook payloads have no routing context and are intentionally unsupported by this router. New submissions must use the updated tool and gateway contracts together.

## Checks

```sh
pnpm --filter @managed-agents/execution-gateway-callback-workers check
pnpm --filter @managed-agents/tool-pi-bash-workers check
pnpm check
```

Local tests use real workerd service RPC, D1 and queues. Router tests cover two isolated receiver bindings, authentication/rotation, conflicting IDs, outage/lost-receipt recovery, invalid receipts, unknown routes, concurrent delivery and restart after failed enqueue. Bash tests exercise the entire router → private tool admission → gateway result → SQLite session path, including early callbacks, independent databases and durable failure recovery. No live gateway/cloud deployment is performed.
