# Stateless execution-gateway callback router

The dedicated execution-gateway user has one common callback URL: `POST /webhooks/execution-gateway`. This worker verifies its signature, forwards inline results to an allowlisted tool receiver, and acknowledges only after that receiver confirms **durable session admission**.

**Deployed on 2026-09-20.** This replaces the old D1/Queue/cron router and notification-only v2 contract. The old consumer is detached and bindings/cron are removed; the database and Queue remain intact and unbound. The dedicated execution user now uses v3 callbacks. See the [deployment report](../../DEPLOYMENT.md) and [stateless bash worker](../tool-pi-bash-workers/README.md).

## Signed contract

```ts
{
  schemaVersion: 3,
  eventId, jobId, machineId, idempotencyKey,
  runtimeGenerationId: string | null,
  type: "job.succeeded" | "job.failed" | "job.unknown",
  completedAt,
  clientContext: { receiver: string, /* opaque tool-owned routing fields */ },
  response: JsonValue,
  error: JsonValue
}
```

Both response and error must be present, including explicit nulls. Failed jobs can contain an execution-protocol error response rather than a gateway error; semantic interpretation belongs to the tool. Unknown outcomes must not trigger automatic command re-execution.

The router requires a well-formed receiver key but does not hardcode bash's remaining context fields. It forwards them unchanged; it never interprets a context URL or follows arbitrary destinations. The bash adapter validates its exact context and job/machine/run/generation relationships.

## Delivery and acknowledgement

1. Enforce POST, JSON content type and a finite 18 MiB raw body cap (the old 16 KiB notification cap is removed).
2. Verify fresh timestamp (five-minute skew), raw-body HMAC and header/body event identity. Current and previous signing secrets support rotation.
3. Validate the complete v3 event and resolve `clientContext.receiver` through `CALLBACK_ROUTES`.
4. Call the receiver's private structured `acceptGatewayEvent(event)` RPC.
5. Validate its `{ receipt: { status: "accepted", eventId, jobId, clientContext } }` reply against the forwarded event.
6. Return 204 only after that receipt. Bash issues it only after the DO commits its inbox admission, not after harness processing.

No D1 calls, Queue messages, local event IDs/leases/retries, scheduled repair or background `waitUntil` forwarding occur. There is no gateway result fetch or gateway credential here. The tool adapter reads the signed inline result.

Unknown/unavailable routes, receiver errors, mismatched receipts or deadline expiry return 503 for gateway retry. Authentication failure returns 401; invalid JSON/event shape returns 400; a body beyond the transport cap returns 413 and is not admitted. These nonretryable protocol/configuration failures need operator attention. Health returns 200 but is not readiness.

The entire callback has one eight-second deadline, below the gateway's ten-second HTTP timeout. Abort cancels stalled body reads. RPC may finish after timeout; the receiver must deduplicate and must never treat transport timeout as proof of non-admission.

## Recovery and security

The gateway alone owns retries and manual redelivery. Its inspected implementation allows eight attempts within a maximum 24-hour window; exhaustion can leave a session waiting until redelivery. There is no independent router sweep to recover missing callbacks. Gateway delivery visibility is now authoritative; no router delivery table exists.

Knowing a session/job ID does not authorize delivery. The public boundary requires HMAC verification; tools expose callback-only private bindings and validate correlation; the DO validates the operation and outcome hash. Keep callback bindings restricted to trusted workers. Body/context/result are authenticated together.

Bash sends host-owned context with receiver, routeKey, sessionId, operationId, submissionId, machineId and timeoutSeconds. Model/harness tool input cannot supply it. Other tools can adopt their own context under their own allowlisted receiver.

## Configuration

- `EXECUTION_GATEWAY_WEBHOOK_SECRET`: dedicated user's signing secret.
- Optional `EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET` for rotation.
- `CALLBACK_ROUTES`: receiver key → existing service-binding name.
- `BASH_EVENTS`: private `PiBashCallbacks` entrypoint on the bash worker.
- Existing public domain `execution-callbacks.acentric.dev`; Workers.dev/preview URLs remain disabled.

No gateway API key, DO namespace, D1 database or Queue binding is required. The cron list is explicitly empty.

## Deployment and breaking rollout

1. Keep new traffic paused while draining all old bash operations, uncertain source retries, router notifications and gateway deliveries. The gateway snapshots the payload version when a job finishes; changing the user's version does not rewrite old retained events.
2. If the gateway user was already switched to v3 while old stateful jobs remain, resolve that mixed state before replacing the receiver. Old context contains only receiver/reference and cannot route statelessly. Do not invent replacement job identities or mark old work delivered.
3. Once drained, detach the old router and bash Queue consumers. Deploy both new adapters together during maintenance. Verify their database/Queue bindings are absent and cron lists are empty.
4. Coordinate the v6 host/API/operation namespace cutover. Preserve old v5 code/data. Configure the dedicated execution user to `webhookPayloadVersion: 3` before sending new work; retain its callback URL and signing secret.
5. Verify a real execution callback only reaches delivered status after DO admission, and that duplicates, command failures and a full harness run behave correctly. Restore traffic only after checks.

The deployment changed the dedicated user's payload setting to v3 without deleting remote resources. Retain old database/Queue resources unbound for separately approved cleanup. Old schemas/context/private RPCs are deliberately unsupported after the cutover.

## Checks

`pnpm --filter @managed-agents/execution-gateway-callback-workers check` covers multiple allowlisted receivers, signature/result tampering, malformed contracts, receiver outage, lost/invalid receipts, large inline payloads and gateway redelivery after process restart, with no router D1/Queue bindings. Bash integration tests add the production tool worker and real session runtime, including early callbacks and the complete deadline. Builds are dry-run only.
