# Stateless LLM operation worker

Implements `llm/generate/v1` as a thin adapter to `../llm-providers/apps/llm-gateway`. The gateway owns durable jobs, idempotency/conflict detection, provider execution, retained results and webhook retries. This Worker owns gateway credentials, operation validation, host-generated routing context, signed callback verification and normalized delivery to the session DO.

**Deployed on 2026-09-20.** Its D1 binding, Queue producer/consumer and recovery cron are absent; old resources remain intact and unbound. Bash and execution callbacks are stateless too. See the [deployment guide](../../DEPLOYMENT.md) and [breaking rollout requirements](#deployment-and-breaking-rollout).

Schema-version-2 callbacks carry their signed terminal result directly. The callback path makes no gateway GET. Live bindings and source/configurations target `minimal-bash/v7`. V6 work was drained before switching; its code/data remains intact. Retained older code/data is unchanged. See the [v7 rollout](../../DEPLOYMENT.md).

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
- Namespace bindings: `MINIMAL_BASH_SESSIONS` for `minimal-bash-v7` in source/configurations and live deployment.

There is no `LLM_DB`, Queue binding or scheduled handler. The host keeps its existing private `LlmGateway` binding and `parseProviderSubmitReply` adapter. No gateway credentials are added to the host. Public routes are only `GET /health` and the signed callback; health is liveness, not readiness. Workers.dev and preview URLs remain disabled.

## Deployment and breaking rollout

The deployed inline-result/v6 release requires signed `schemaVersion: 2` events including `response` and `error` on initial delivery and redelivery. Live gateway delivery was verified. The previous notification-only receiver rejects v2. When repeating this rollout elsewhere, pause new traffic and resolve/drain old work before switching namespaces. If v5 callbacks remain, first deploy the inline receiver with the existing v5 binding (a staged config), and redeliver/verify them; do not redirect old callbacks to v6. Then follow the host's [fresh-namespace rollout](../harness-minimal-bash/README.md#setup-and-rollout). There are no new databases, Queues or schema migrations. Keep all old namespace data/code intact.

The following records the **previous stateful → stateless rollout**; it is not a reason to recreate or re-drain already detached LLM resources:

The gateway must first persist and echo per-job `clientContext` for fresh/continuation requests, expose it in job detail, cover it in webhook signatures and include it in idempotency conflicts.

1. Pause new input/resume traffic across all affected harnesses and let existing processing/jobs finish using the old Worker. Drain the old `llm_operations` and `llm_webhook_events` work, outstanding gateway deliveries, and old LLM Queue work. Verify there are no uncertain/replaying submissions, not just no currently running provider jobs.
2. Detach the old `managed-agents-llm-completions` consumer after draining. Deploy only this Worker with its existing secrets, domain and namespace bindings. Verify its Queue producer/consumer bindings are gone and its cron list is empty; removing code alone is not proof that cloud triggers were removed.
3. Do **not** drop/delete the old `managed-agents-llm-operations` database or Queue as part of this code change. They can be retained unbound for separately approved cleanup. The removed local migration is not a remote DROP operation.
4. Restore traffic and verify a real LLM/bash/LLM run, gateway callback `delivered` status, DO transcript/status and duplicate delivery. There is no Worker `delivered_at` to query anymore. Existing drained v5 sessions can continue; no API/harness schema update is necessary.

Do not switch a live context-free operation to this receiver: it cannot infer routing without the old mapping. Do not reuse an in-flight pre-change submission with added context under the same idempotency key: the gateway correctly reports a conflict. Rolling back to the old stateful receiver also requires draining new-context jobs first. Neither direction supports mixed in-flight protocols.

First-time setup only requires gateway URL/user credentials, callback origin allowlist/user callback configuration and existing session namespace bindings. No LLM D1/Queue provisioning or migrations. Keep the same gateway user/origin for outstanding jobs; credential rotation for that same user is supported.

## Checks

Run `pnpm --filter @managed-agents/llm-gateway-workers check` or `pnpm check`. Checks never deploy or call real gateways.

Tests run production RPC, HTTP handlers and SQLite session runtime in workerd with **no LLM D1 or Queue bindings**. They cover early/duplicate/concurrent callbacks, lost submission responses, terminal replay, lost/invalid admission receipts, signature/context tampering, context conflicts, continuation routing, restart with gateway redelivery, fetch/correlation failures, oversized results/error pages and a shared callback deadline. Full-stack minimal-bash tests also use the real stateless LLM Worker with fake gateways. The stateless bash/router release likewise tests without adapter D1/Queue bindings.
