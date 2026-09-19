# Pi-style bash operation worker

Implements `tool-pi-bash/bash/v1` using `execution.run` in `../execution-providers/apps/execution-gateway` (process-execution protocol **4**). The worker owns the dedicated gateway user's API key, stable job submission, result formatting, recovery and completion delivery to session Durable Objects. The [shared callback worker](../execution-gateway-callback-workers/README.md) owns the public webhook, signing secrets and durable notification routing. `agent-api` and the session runtime do not call the gateway or receive its webhooks.

## Input and result

Shared contracts live in `packages/contracts/src/pi-bash.ts`. Give the LLM `PI_BASH_TOOL`: Pi's bash description and `{ command: string, timeout?: number }` JSON schema. The harness validates the model arguments with `parseBashToolInput`, then adds the trusted execution destination:

```ts
// Harness definition: operations: [PI_BASH_OPERATION, ...]
ctx.requestOperation({
  ...PI_BASH_OPERATION,
  input: {
    ...parseBashToolInput(modelArguments),
    machineId: config.machineId, // UUID owned by the worker's dedicated gateway user
    cwd: config.cwd,             // Absolute path on that machine
  },
});
```

`timeout` is optional seconds, with no default; positive finite values up to 2,147,483.647 seconds match Pi's Node timer range. Fractional milliseconds are truncated and sub-millisecond timeouts become 1 ms. Empty commands are valid. Extra fields, NUL bytes, relative paths, credentials, callback URLs, environment overrides and shell overrides are rejected. `machineId`/`cwd` are harness inputs, **not** model tool arguments. The shared operation contract allows up to 8 MiB of UTF-8 JSON input; the session stores large payloads in transactional SQLite chunks. Gateway-specific command/request limits and the existing Pi output-preview bounds still apply.

The worker submits one gateway job:

```ts
{
  machineId,
  idempotencyKey: "pi-bash-v1:<sha256(submissionId)>",
  clientContext: { receiver: "tool-pi-bash-v1", reference: submissionId },
  request: {
    operation: "execution.run",
    params: {
      run_id: "pi-bash-v1:<sha256(submissionId)>",
      command: { type: "shell", script: command,
                 shell: { executable: "bash", kind: "bash" }, login: false },
      cwd,
      max_output_bytes: 65536,
      // timeout_ms only when timeout was supplied
    },
  },
}
```

The host captures stdout/stderr in arrival order, closes stdin, spools the full output from the beginning, and returns a bounded tail when the command finishes. No `observe` loop or second result-collection job is needed.

The session receives `runtime.operation.completed` with this successful operation result:

```ts
{
  status: "succeeded",
  result: { // BashResult
    content: [{ type: "text", text: "<formatted output and any status/truncation notice>" }],
    isError: false,
    details: {
      gatewayJobId, machineId, runId, executionHandle,
      reason, exitCode, signal, timedOut,
      fullOutputPath,
      outputFile: { artifactId, sizeBytes, sha256, complete, expiresAt },
      truncation: { truncated, truncatedBy, outputLines, outputBytes,
        maxLines: 2000, maxBytes: 51200, totalLines, totalTextBytes,
        upstreamTruncated, lastLinePartial },
    },
  },
}
```

The model-facing text keeps the **last 2,000 lines or 50 KiB**, whichever limit is reached first; there is no head section. Truncation notices/status text are additional to that preview limit, as in Pi. Small output preserves its trailing newline. Oversized final lines are cut at a UTF-8 boundary. Raw stdout/stderr chunks are joined before decoding so split characters survive. If the gateway's 64-KiB tail omitted the beginning, original text/line counts are `null`; the notice does not invent full-file line numbers. The full path and expiry are always in details and the path is included in text when truncated/incomplete. The path is machine-local, not a download URL. Persist `details` if a harness wants to inspect the file in a later tool call.

Exit zero with complete capture has `isError: false`. Known nonzero exits, signals, timeouts, termination, launch failure or incomplete capture produce `isError: true`, retaining available output and an explanation. They are still **completed tool invocations** (`OperationOutcome.status: "succeeded"`), not submission failures to retry. A harness should pass `content`/`isError` back as the corresponding LLM tool result.

Gateway/protocol failures produce `status: "failed", origin: "execution"`. Gateway `unknown` or core `lost` becomes `BASH_EXECUTION_UNKNOWN`: the command may have run and must not be automatically repeated. A missing accepted job or malformed/miscorrelated response stays in recovery with `last_error`; the worker never submits it again. All these outcomes are delivered through the existing completion contract.

## Durable flow and storage

1. Private submit RPC validates input/destination and reserves a D1 mapping with a normalized request hash.
2. Submit the gateway job with stable `idempotencyKey` and `run_id`. Store its job ID before acknowledging `accepted`. The session can then delete its outbox input.
3. The gateway echoes worker-generated `clientContext` to the shared callback worker. That app verifies and persists the event, then routes it to `PiBashCallbacks.acceptGatewayEvent` through a private binding.
4. Bash validates receiver/reference/machine/job correlation, atomically binds the job and makes the operation due, then acknowledges the router. It immediately continues result delivery with `waitUntil` for normal accepted jobs. A rare callback that arrives while the original submit RPC is still on the stack uses Queue once to avoid re-entering the same session Durable Object. No gateway lookup is needed for callback admission. Duplicate admission is safe and does not clear active leases or prior delivery.
5. Bash fetches the authoritative terminal result directly by the known job ID, without an idempotency-key lookup, and calls the session's private `acceptCompletion` path. Record delivery only after the durable session receipt. Each attempt after a callback/retained terminal observation uses one gateway detail request; job ID, machine, idempotency key and response correlation are still validated.
6. Metadata polling and the once-a-minute recovery sweep repair missing callbacks, exhausted/lost queue messages and expired leases. Pending jobs do not download the retained command/result. Router delivery and session completion delivery have separate durable acknowledgement boundaries.

If polling first discovers completion, that attempt uses a metadata lookup followed by the detail read; later retries skip the lookup. This uses the existing `GET /v1/jobs/{jobId}` endpoint, which still includes the retained original request. A lightweight result-only gateway endpoint is separate future work.

`migrations/0001_initial.sql` defines one table:

- `bash_operations`: submission/operation/session routing, machine ID, timeout seconds, request hash, gateway key/job ID, state, rejection, delivery and retry/lease/error metadata.

**It stores no commands, cwd, output or full gateway responses.** Queue messages contain only `{ kind: "operation", id }`. D1 is the recovery source; Queue is normally a retry/recovery mechanism (batch size 1, zero batch timeout), plus the early-callback re-entrancy guard described above. There is no bash webhook table or cross-worker database access. Gateway requests have a 7-second deadline; session admission has a 10-second deadline. Retries reuse the same identities. The gateway retains terminal responses/idempotency records; deleting them or switching gateway user/origin while work is outstanding breaks recovery. Rotating the API key for the same user is fine.

Mappings have no automatic pruning yet. The recovery sweep enqueues up to 100 due IDs per minute, with retry backoff up to five minutes. Monitor undelivered operations, oldest due time and `last_error`. Sustained backlogs require tuning throughput; removing a session route needs an explicit abandonment policy.

## Private host integration

`PiBash` is a named `WorkerEntrypoint`, accessible only via service bindings. Both methods take/return JSON strings:

| Method | Input | Output |
|---|---|---|
| `submit` | `{ destination: { routeKey, sessionId }, submission: ProviderSubmission }` | `ProviderSubmitResult` |
| `get` | `ProviderStatusQuery` | `ProviderStatusResult` |

The separate `PiBashCallbacks` entrypoint exposes only `acceptGatewayEvent(ExecutionGatewayEvent)` → `GatewayEventReceipt`, also serialized as JSON strings. Bind only the trusted shared callback worker to it, using `GatewayEventReceiverBinding`; it has no command-submission method. The callback's reference is `submissionId`, and `PI_BASH_RECEIVER` fixes its receiver key. Neither is accepted from model/harness tool input. The shared router owns signature verification and event-ID deduplication; bash owns reference/job correlation and idempotent durable wake-up admission.

Add a host binding and type `env.BASH` as `BashWorkerBinding`:

```jsonc
"services": [{ "binding": "BASH", "service": "managed-agents-tool-pi-bash", "entrypoint": "PiBash" }]
```

Register this adapter under `"tool-pi-bash"` in the host's `SessionDriver` provider map:

```ts
"tool-pi-bash": {
  submit: async submission => parseProviderSubmitResult(JSON.parse(await env.BASH.submit(JSON.stringify({
    destination: { routeKey: "my-harness-v1", sessionId: this.driver.getSession().identity.sessionId },
    submission,
  })))),
  get: async query => parseProviderStatusResult(JSON.parse(await env.BASH.get(JSON.stringify(query)))),
}
```

The host, not model arguments, selects the session destination. Bind its existing SQLite namespace in this worker:

```jsonc
"vars": {
  "EXECUTION_GATEWAY_URL": "https://execution.example.com",
  "SESSION_ROUTES": "{\"my-harness-v1\":\"MY_SESSIONS\"}"
},
"durable_objects": { "bindings": [{
  "name": "MY_SESSIONS", "class_name": "MySession", "script_name": "my-harness-host"
}] }
```

The host must expose the existing private session protocol: `sessionRequest(JSON.stringify({ action: "acceptCompletion", value: OperationCompletion }))`, call `SessionDriver.acceptCompletion` and return JSON `{ ok: true, value: CompletionReceipt }` only after admission commits. Restrict bindings to trusted workers. Machine ownership is enforced by the dedicated gateway user; that does not provide per-session isolation. Only authorize hosts/harnesses to machines they should control. `cwd` is not a filesystem sandbox.

The [minimal-bash host](../harness-minimal-bash/README.md) now implements the model → serial bash → model loop and private adapter. This worker maps `minimal-bash-v1` to its `MINIMAL_BASH_SESSIONS` namespace. Establish the namespace before activating that binding; see the host's first-deployment guidance. `test/fixture.ts` stays test-only.

## Deployment

No resources are provisioned by tests/build. Before deploying:

1. Run compatible protocol-4 execution gateway and machine daemon. Use a dedicated gateway user and register its machines; ensure `bash` is on their PATH.
2. From this app directory, provision resources, replace `database_id` in Wrangler config, then migrate:

   ```sh
   pnpm exec wrangler d1 create managed-agents-bash-operations
   pnpm exec wrangler queues create managed-agents-bash-completions
   pnpm exec wrangler d1 migrations apply BASH_DB --remote
   ```

3. Set `EXECUTION_GATEWAY_URL` and session bindings/`SESSION_ROUTES`. Bash requires no public route. Preview and workers.dev URLs are disabled.
4. Set the dedicated user's API key (not admin credentials), then deploy:

   ```sh
   pnpm exec wrangler secret put EXECUTION_GATEWAY_API_KEY
   pnpm exec wrangler deploy
   ```

5. Deploy/configure the [shared callback worker](../execution-gateway-callback-workers/README.md), including its `BASH_EVENTS` service binding to `PiBashCallbacks`, signing secret, public callback URL and gateway origin allowlist. Use **`webhookPayloadVersion: 2`**. The gateway must support persisted/echoed `clientContext`.
6. Configure the host adapter and exercise a real job; verify router delivery, bash `delivered_at` and the session result. Health is liveness only, not an assertion that credentials/namespaces work.

Webhook signing-secret rotation belongs solely to the callback worker. Bash no longer has webhook secrets or a public callback endpoint. For an existing deployment, follow the callback worker's breaking-rollout guidance before changing the initial schema, callback URL or submission context. No compatibility path or live database cleanup is performed here.

The only HTTP handler is `GET /health`. Command submission, status and callback admission are private RPC. There is no callback URL per tool or session.

## Upstream limits and Pi differences

- **Timeout grace:** the core currently requests graceful termination at the timeout and defaults to a further two-second grace before force-kill; Pi kills the process tree immediately. There is no per-run grace parameter. This worker preserves the core's explicit `timed_out` reason. Strict Pi timing needs an upstream run-specific policy; changing the global grace also affects other execution operations.
- **Output storage:** full logs default to 24-hour retention. The core's periodic cleaner tracks in-memory runs; it does not scan/reclaim pre-restart orphan log files. There is no per-run or total spool disk quota. Add quota enforcement and restart-safe garbage collection upstream before relying on this for untrusted, high-volume output.
- **Long-term command retention:** gateway request rows expire, but a successful run's retained response includes `execution.command`. Thus command text survives in gateway responses; this worker does not duplicate it. If removing completed command text is a requirement, change that upstream response/retention policy.
- **Later file reads:** there is no ranged-read operation and the existing whole-file read is bounded. Use a subsequent bash command such as `sed`/`tail` on `fullOutputPath`, within the file's retention horizon. Files can disappear after expiry while the gateway's immutable result/path remains queryable.
- **Shell environment:** runs use the host's configured environment and non-login `bash`; Pi's local shell discovery/fallback, optional command prefixes, `PI_*` variables and session-specific shell setup are not automatically reproduced. Configure the host appropriately.
- **No streaming/cancellation API yet:** this is a final-result tool. The upstream `execution.terminate_run` exists, but the session-runtime cancellation delivery contract does not; no unauthenticated or ad-hoc cancellation endpoint is added here.

## Checks

```sh
pnpm --filter @managed-agents/tool-pi-bash-workers check
pnpm check
```

Tests cover the Pi limits/UTF-8 handling and real workerd service RPC, D1, queues and SQLite session objects against a deterministic gateway fixture. They exercise success, command errors, timeout, unknown/lost outcomes, signed/early/duplicate callbacks, lost acceptance/receipt, D1 failures, immutable/concurrent submissions, missing accepted jobs, and restart/cron recovery. Test fixtures are excluded from the production bundle. Live gateway/cloud deployment is a separate check.
