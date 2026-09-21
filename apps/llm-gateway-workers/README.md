# Stateless LLM operation worker

Implements `llm/generate/v1` as a thin adapter to `../llm-providers/apps/llm-gateway`. The gateway owns durable jobs, idempotency/conflict detection, provider execution, retained results and webhook retries. This Worker owns gateway credentials, operation validation, host-generated routing context, signed callback verification and normalized delivery to the session DO.

This adapter has no D1 database, Queue or recovery cron. Schema-version-2 callbacks
carry their signed terminal result directly; the callback path makes no gateway GET.
Session route bindings cover both minimal-bash and Pi no-compaction.

## Submission

The private `LlmGateway.submit` RPC accepts:

```ts
{
  destination: { routeKey, sessionId },
  submission: {
    operationId, submissionId,
    request: { provider: "llm", type: "generate", version: "v1", input }
  }
}
```

It validates the envelope and LLM input, checks the configured return route, and calls authenticated `POST /v1/jobs` with:

```ts
{
  ...normalizedInput,
  idempotencyKey: "ma-v1:" + sha256(submissionId),
  clientContext: { routeKey, sessionId, operationId, submissionId }
}
```

The destination comes from the trusted host adapter, not model/harness input. `clientContext`, callback URLs, credentials and caller-supplied idempotency keys are rejected as LLM input fields. A fresh request defaults `previousJobId` to null, `tools` to `[]` and `providerOptions` to `{}`. Full native assistant messages are preserved. The continuation form is `{ previousJobId, messages }`; it receives this submission's own context, never the parent's context.

The Worker returns `{ result: { status: "accepted", jobId } }` after gateway acceptance, without waiting for generation. If POST returns an already-terminal job, it fetches/validates the result and returns `{ result: { status: "completed", jobId, outcome } }`. This handles replay even when an earlier callback was already acknowledged or its retries exhausted. A failed terminal detail read remains an error, never a submission rejection.

Definitive pre-acceptance gateway errors return `{ result: { status: "rejected", error } }`. Authentication failures, idempotency conflicts, malformed responses, timeouts and uncertain acceptance throw: the runtime retains its source and retries the same deterministic identity. Every submission retry POSTs to the gateway; the gateway returns the existing job or rejects changed input/context. There is no local accepted/rejected cache or full-request fingerprint.

Normal submission has **zero D1 calls, zero Queue messages and one gateway POST**. Gateway request/result storage policies are unchanged. The private diagnostic `get`, metadata polling, local operation/event tables, migrations, leases, retry counters and recovery cron are removed.

## Callback and acknowledgement

The configured gateway user's common callback remains `POST /webhooks/llm-gateway`. The signed body must be:

```ts
{
  schemaVersion: 2,
  eventId, jobId, completedAt,
  type: "job.succeeded" | "job.failed" | "job.cancelled",
  clientContext: { routeKey, sessionId, operationId, submissionId },
  response: AssistantResponse | null,
  error: { code: string, message: string, /* gateway error fields */ } | null
}
```

1. Verify raw-body HMAC, five-minute timestamp freshness, and matching header/body event ID. Signing-secret rotation is supported.
2. Validate the exact context shape and select a configured namespace using the allowlisted route key. Never follow an arbitrary URL from context.
3. Validate the inline terminal result and normalize it into the shared operation outcome. Success requires `response` and null `error`; failure requires null `response` and an error; cancellation requires both null. No gateway request is made, including on duplicate delivery. The signature authenticates the routing context, job ID and result; DO admission still verifies operation/job correlation and outcome hashes.
4. Call `sessionRequest({ action: "acceptCompletion", value: { provider: "llm", operationId, submissionId, jobId, outcome } })` on the named session DO.
5. Return `204` **only after** a matching durable admission receipt. Harness processing may happen later.

There is no D1 access, Queue fallback, `waitUntil` forwarding or local delivery state. Admission failures and unavailable route bindings return `503` so the gateway retries. A lost acknowledgement or concurrent duplicate is safe because the DO deduplicates by operation/completion content. Early callbacks are admitted behind their still-unconsumed initiating input, using the runtime's existing reconstructed-plan checks.

Each submission and each entire callback has one **eight-second deadline**. Callback timing includes body reading, verification, result validation and DO admission, below the gateway's ten-second callback timeout. Gateway HTTP calls also have a seven-second maximum within that shared budget. Deadline expiry aborts fetch/body consumption; RPC cannot be aborted, so late admission is permitted and deduplicated on redelivery. Exhausted budget never authorizes returning success before admission.

Invalid signatures/freshness return `401`; malformed or missing context returns `400`. Old context-free or notification-only callbacks are deliberately unsupported. Terminal submission replay still fetches job detail and verifies its idempotency key, context and status. Missing accepted jobs and inconsistent results are not permission to create replacement executions.

## Results and limits

Success is `{ status: "succeeded", result: { gatewayJobId, response } }`, preserving the full gateway assistant response. Execution errors become `{ status: "failed", origin: "execution", error: { code, message, details: { gatewayJobId } } }`; cancellation becomes `{ status: "cancelled" }`.

Inputs allow 8 MiB of UTF-8 JSON; complete outcomes allow 1,900,000 bytes. Oversized results become a small `LLM_RESULT_TOO_LARGE` terminal failure, delivered normally so the harness can fail the run. The original remains at the gateway. Job-detail reads keep their 32 MiB transport cap because the endpoint also returns retained request history; exceeding a successful response's transport cap likewise yields the size failure. Oversized non-success HTTP error pages remain retryable transport errors, not model failures. Callback bodies now use the same 32 MiB transport cap, rather than the old 16 KiB notification cap. Within it, oversized valid results become `LLM_RESULT_TOO_LARGE`; a callback body above the cap receives `413` before authentication/JSON parsing, cannot be durably admitted, and needs operator attention. There is deliberately no callback-path GET fallback. No R2 references are implemented.

## Recovery ownership and limitations

Before local commit, the runtime owns replay of uncertain submission under the same identity. After acceptance, the **gateway alone owns callback retries**; this Worker has no sweep to recover a missing/exhausted callback. As inspected, gateway delivery has eight attempts, a 24-hour retry-window cap and a ten-second HTTP timeout. Eight attempts can exhaust before 24 hours. A session can remain waiting after exhaustion; use the gateway's failed-delivery visibility and manual redelivery. Preserve gateway job/result records and credentials for the recovery horizon.

This is at-least-once delivery, not exactly-once provider execution. The gateway marks callback delivery complete only after this Worker has acknowledged durable DO admission. Alerting/automatic replay of exhausted gateway deliveries is outside this adapter. Callback verification requires the owning gateway user's signing secret; normal callback delivery no longer uses the gateway API key. Submission and terminal replay still require that user's API key.

## Bindings and secrets

- `GATEWAY_URL`: HTTPS gateway origin.
- `GATEWAY_API_KEY`: dedicated gateway user's API key.
- `GATEWAY_WEBHOOK_SECRET`: that user's signing secret.
- Optional `GATEWAY_PREVIOUS_WEBHOOK_SECRET` during rotation.
- `SESSION_ROUTES`: map allowed route keys to existing DO namespace bindings.
- Namespace bindings: `MINIMAL_BASH_SESSIONS` for `minimal-bash-v7` and `PI_NO_COMPACTION_SESSIONS` for `pi-no-compaction-v1`.

There is no `LLM_DB`, Queue binding or scheduled handler. The host keeps its existing private `LlmGateway` binding and `parseProviderSubmitReply` adapter. No gateway credentials are added to the host. Public routes are only `GET /health` and the signed callback; health is liveness, not readiness. Workers.dev and preview URLs remain disabled.

## Setup and rollout

Configure the gateway URL/user credentials, callback origin allowlist/user callback
configuration, and matching session namespace bindings and `SESSION_ROUTES`.
No LLM D1 database, Queue or migration is required.

The gateway must persist and echo per-job `clientContext`, include it in job detail
and idempotency conflicts, and sign schema-version-2 callbacks with inline
`response` and `error`. Context-free and notification-only callbacks are unsupported.

Before changing callback protocols or session destinations, pause affected traffic
and drain or reconcile outstanding work. Do not redirect callbacks for one
namespace into another. Preserve job records and the gateway user/origin for
outstanding deliveries; credential rotation for that same user is supported.
Verify callback delivery, durable session admission and duplicate delivery before
restoring traffic. Local checks do not deploy or remove any remote resources.

## Checks

Run `pnpm --filter @managed-agents/llm-gateway-workers check` or `pnpm check`. Checks never deploy or call real gateways.

Tests run production RPC, HTTP handlers and SQLite session runtime in workerd with **no LLM D1 or Queue bindings**. They cover early/duplicate/concurrent callbacks, lost submission responses, terminal replay, lost/invalid admission receipts, signature/context tampering, context conflicts, continuation routing, restart with gateway redelivery, fetch/correlation failures, oversized results/error pages and a shared callback deadline. Full-stack minimal-bash tests also use the real stateless LLM Worker with fake gateways.
