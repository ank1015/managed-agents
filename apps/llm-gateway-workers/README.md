# LLM operation worker

Implements `llm/generate/v1` against `../llm-providers/apps/llm-gateway`. This worker owns gateway authentication, submission/idempotency mapping, its public callback URL, polling, and durable completion delivery to session Durable Objects. The gateway owns accounts, provider execution, and retained jobs/results. `agent-api` is not in the callback path.

Use one dedicated gateway user per environment. Its accounts are the accounts available to these harnesses. Store its user API key here, not gateway-admin credentials or individual provider keys. Account IDs and model IDs are operation inputs; secrets and destinations are deployment-owned.

## Flow and ownership

```text
session outbox -> private submit RPC -> D1 reservation -> gateway POST /v1/jobs
                                     <- persist job ID <- durable acceptance
session deletes operation input <- accepted { jobId }

gateway -> signed webhook -> D1 event -> inline fetch of terminal gateway result
                                              -> session.acceptCompletion
                                              <- durable receipt -> mark delivered
```

The worker accepts an operation only after BOTH the gateway job and its D1 routing record are durable. A lost response or failed D1 mapping write causes the session to retry the same submission. The gateway key is `ma-v1:` plus SHA-256 of the runtime's submission ID; normalized input is hashed separately to detect conflicting retries. Identical retries recover the original gateway job ID, which is also the worker's `jobId`.

Before acceptance the session still owns submission retries. After acceptance this worker owns completion delivery, even if the session makes no more calls. The authenticated terminal callback continues directly after D1 admission; normal submissions do not enqueue an eager pending poll. Queue retries and a one-minute scheduled sweep recover failures, lost callbacks, expired leases and interrupted invocations. Pending recovery checks only metadata; terminal jobs download the response. The session's normal status reconciliation remains an independent recovery path through this worker.

Callback admission checks HMAC, timestamp freshness (five minutes), and header/body event identity before persisting the event. It returns 204 only after D1 persistence and uses `waitUntil` for immediate processing; a failed fast path is queued and D1 remains recoverable even if that enqueue fails. An early callback recovers the reservation using the gateway job's idempotency key. Duplicate events, concurrent delivery, and a lost session receipt are safe. D1 marks delivery complete only after the session returns the matching durable receipt, not merely after making the RPC call. Processing by the harness can occur later.

Delivery is at least once; the session deduplicates the completion. This does not promise exactly-once upstream model execution. Missing accepted jobs, configuration/authentication failures, and uncertain submissions remain retryable errors, not invented terminal failures. No cancellation request API is implemented; gateway cancellation is translated if it occurs.

## Operation contract

Shared types and validators live in `packages/contracts/src/llm.ts`. A harness declares `LLM_OPERATION` in its `operations` allowlist, then requests:

```ts
ctx.requestOperation({
  provider: "llm", type: "generate", version: "v1",
  input: {
    accountId: "<gateway-user-owned-account-uuid>",
    modelId: "<gateway-catalog-model-id>",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    // Optional: instructions, tools, providerOptions. previousJobId defaults to null.
  },
});
```

Fresh input is `{ accountId, modelId, messages, instructions?, tools?, providerOptions?, previousJobId?: null }`. Continuation input is **only** `{ previousJobId, messages }`: it inherits the successful parent's account/model/settings and appends messages to its retained history. Expired parent requests cannot continue. The upstream gateway currently defaults request retention to seven days and reconstructs a complete snapshot for every continuation; this worker does not change that upstream storage policy.

Message roles are `user`, `system`, `assistant`, `tool_result`, and `custom`. Assistant content preserves opaque provider-native items, including replay/reasoning/tool-call data. Function tools and custom Lark-grammar tools are supported. The worker rejects callback URLs, credentials, caller-supplied idempotency keys, and other unknown top-level input fields.

Successful runtime outcome:

```ts
{
  status: "succeeded",
  result: {
    gatewayJobId: string,
    response: {
      id: string, modelId: string, resolvedModelId?: string,
      message: LlmAssistantMessage,
      stopReason: "stop" | "length" | "tool_use" | "refusal" | "content_filter" | "pause_turn",
      usage?: LlmResponse["usage"], durationMs: number, timestamp: number
    }
  }
}
```

The harness receives this through `runtime.operation.completed`, not a public output endpoint. Gateway failures become `{ status: "failed", origin: "execution", error: { code, message, details: { gatewayJobId } } }`; cancellation becomes `{ status: "cancelled" }`. Definitive submission rejection returns the provider contract's `rejected`; the session constructs its submission-origin failure.

Operation inputs and complete outcomes are limited separately to **8 MiB of UTF-8 JSON**, enforced in the shared contracts. Session persistence uses transactional chunked SQLite rows for large payloads, including outcomes and completion events. Oversized gateway results produce `LLM_RESULT_TOO_LARGE` with the gateway job ID; they are not truncated. The original stays in the gateway. Detail reads include the retained request too, so their transport cap is 32 MiB (16 MiB upstream request + 8 MiB result + envelope headroom). This worker still stores only routing/hash/retry metadata in D1; no full prompt/result copies are added there. R2 references are not implemented. Deploy the updated session host/runtime before delivering larger results.

## Private RPC and host integration

The named `LlmGateway` WorkerEntrypoint exposes two methods taking and returning JSON strings:

| Method | Input | Output |
|---|---|---|
| `submit` | `{ destination: { routeKey, sessionId }, submission: ProviderSubmission }` | `ProviderSubmitResult` |
| `get` | `ProviderStatusQuery` | `ProviderStatusResult` |

Bind a harness host to it:

```jsonc
"services": [{ "binding": "LLM", "service": "managed-agents-llm-gateway", "entrypoint": "LlmGateway" }]
```

Type `env.LLM` as `LlmWorkerBinding`. Supply this adapter to `SessionDriver` under the `llm` key (imports below are from `@managed-agents/contracts`):

```ts
llm: {
  submit: async submission => parseProviderSubmitResult(JSON.parse(await env.LLM.submit(JSON.stringify({
    destination: { routeKey: "my-harness-v1", sessionId: this.driver.getSession().identity.sessionId },
    submission,
  })))),
  get: async query => parseProviderStatusResult(JSON.parse(await env.LLM.get(JSON.stringify(query)))),
}
```

Service RPC is a trusted internal boundary, not a public HTTP API. The driver bounds calls even though RPC itself cannot be aborted. The worker independently bounds gateway requests and completion delivery. The host—not the harness—chooses the destination. Do not expose these bindings directly to end users.

In this worker's Wrangler configuration, map each allowed route key to the corresponding existing SQLite namespace:

```jsonc
"vars": { "GATEWAY_URL": "https://gateway.example.com", "SESSION_ROUTES": "{\"my-harness-v1\":\"MY_SESSIONS\"}" },
"durable_objects": { "bindings": [{
  "name": "MY_SESSIONS", "class_name": "MySession", "script_name": "my-harness-host"
}] }
```

The session host must implement `sessionRequest(JSON.stringify({ action: "acceptCompletion", value: OperationCompletion }))`, authenticate by restricting access to trusted bindings, call `SessionDriver.acceptCompletion`, and return JSON `{ ok: true, value: CompletionReceipt }` only after admission commits. The existing internal session protocol already has this shape. No new Durable Object class or namespace is created by this worker.

The [minimal-bash host](../harness-minimal-bash/README.md) provides the coding loop and private adapter. This worker's config maps `minimal-bash-v1` to its `MINIMAL_BASH_SESSIONS` namespace. Establish that host namespace before activating the binding; see its first-deployment guidance. `test/fixture.ts` remains a test-only host and must never be deployed.

## Storage

`migrations/0001_initial.sql` is the complete initial D1 schema:

- `llm_operations`: submission/operation IDs, session destination, normalized request hash, gateway key/job ID, state, definitive rejection if any, delivery timestamp, retry deadline, attempt count, and fenced lease/error fields.
- `llm_webhook_events`: event identity, gateway job ID/type/completion time, admission/processing timestamps, and retry/lease/error fields.

Neither table stores operation inputs or model results. Queue messages contain only `{ kind: "operation" | "event", id }`. D1 is the recovery source of truth; Queue is a retry/recovery mechanism rather than the normal completion path. The consumer uses batch size 1 and zero batch timeout. The gateway remains authoritative for results and idempotency, so preserve its user and job records throughout the recovery horizon. Changing the gateway user/origin with outstanding jobs is not a supported migration. Key rotation for the SAME user is fine.

Mappings and webhook receipts are retained without automatic pruning in v1. Growth is metadata per operation, not repeated prompts. The scheduled sweep publishes at most 100 due work IDs per run; Queue retry delays back off to five minutes. Monitor undelivered rows, oldest due time, `last_error`, and unprocessed events; sustained backlog requires increasing recovery throughput. Route removal/deleting sessions requires a future explicit abandonment policy rather than silently dropping results.

## Deployment

No cloud resources are provisioned by the tests or build. Before deploying:

1. Create the dedicated gateway user and add its provider accounts. The gateway API and its execution worker must both run.
2. Provision D1 and Queue; run these from this app directory, then replace `database_id` in `wrangler.jsonc`:

   ```sh
   pnpm exec wrangler d1 create managed-agents-llm-operations
   pnpm exec wrangler queues create managed-agents-llm-completions
   pnpm exec wrangler d1 migrations apply LLM_DB --remote
   ```

3. Set `GATEWAY_URL`, session namespace bindings/`SESSION_ROUTES`, and a public HTTPS custom domain/route. `workers_dev` and preview URLs are disabled. On the gateway, allow this callback origin in `WEBHOOK_ALLOWED_ORIGINS`. Configure the dedicated user's `callbackUrl` (admin user creation/update or `PATCH /v1/me`) to `https://<worker-domain>/webhooks/llm-gateway`.
4. Install the dedicated user's secrets (the webhook secret is returned when creating the user or rotating its webhook secret):

   ```sh
   pnpm exec wrangler secret put GATEWAY_API_KEY
   pnpm exec wrangler secret put GATEWAY_WEBHOOK_SECRET
   pnpm exec wrangler deploy
   ```

5. Configure each LLM-capable session host's named service binding and adapter above. Exercise one real job and confirm `delivered_at` and the session's durable result before routing production workloads.

For webhook rotation, retain the former secret temporarily as optional `GATEWAY_PREVIOUS_WEBHOOK_SECRET`, then install the new current secret; remove the former after in-flight old-signed deliveries have drained. Callback URLs are captured when gateway jobs become terminal, so keep an old URL reachable while its events drain if moving domains.

Public routes are only `GET /health` and `POST /webhooks/llm-gateway`. The callback is shared across sessions for this gateway user; D1 maps each job to its destination. Liveness health does not assert valid deployment credentials/bindings.

## Checks

```sh
pnpm --filter @managed-agents/llm-gateway-workers check
pnpm check
```

Tests use real workerd, named service RPC, D1, Queues, and SQLite session objects with a deterministic fake gateway matching the inspected upstream contracts. They cover success/native-response preservation, early/duplicate callbacks, lost acceptance/receipt, D1 failures, transient delivery failures, HMAC/freshness/rotation, immutable retries, terminal outcomes and size limits, missing accepted jobs, expired leases, and full process restart/scheduled recovery. No live provider calls occur. Fixtures are excluded from the production bundle.
