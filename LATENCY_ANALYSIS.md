# Live session latency analysis

Latest full production retest: [E2E_RETEST_REPORT.md](E2E_RETEST_REPORT.md). All five workflow scenarios passed after optimization: 13 LLM and 9 bash operations, 181.931s active time including 40s of deliberate sleeps. Mean external-completion-to-recorded-delivery latency was 2.251s for LLM and 1.441s for bash (73.0% and 77.9% lower than the original baseline). Managed-agents completion/orchestration accounted for 23.1% of active time. The report includes workload differences, measurement limits and independent verification.

## Optimization implemented

The completion path measured below is the pre-change baseline. The identified hot-path delays have now been removed in code:

- LLM webhooks persist to D1 and continue event transfer, terminal result retrieval and session admission inline through `waitUntil`; there is no second Queue hop.
- Execution callbacks persist to D1 and route directly to the tool callback binding; bash then retrieves the result and admits it to the session inline.
- A bash callback that races the still-active submit RPC uses one Queue handoff to avoid re-entering the same session Durable Object.
- Newly accepted pending LLM/bash jobs no longer enqueue an eager poll. D1 deadlines, provider status reconciliation and cron retain recovery.
- All three fallback Queue consumers now use batch size 1 and zero-second batch timeout.

D1 leases, idempotent receipts, retry backoff, Queue fallback and once-per-minute recovery remain intact. The full local test suite covers Queue-disabled fast paths, failures, duplicates, early callbacks and restart recovery. The fresh production run below measures the achieved reduction against this baseline.

### Post-deployment production verification

After deploying the optimized Workers, a fresh `gpt-5.6-sol` / medium session ran the real LLM → bash → LLM path and returned the exact expected result. Session: `ses_ab81dd2e-85aa-4387-aa5b-4873e11a3bd8`.

| Completion interval | Baseline | Optimized smoke | Reduction | Speedup |
|---|---:|---:|---:|---:|
| LLM external completion → session acknowledgement | 8.350s average | 3.660s average (two jobs) | 56.2% | 2.28× |
| Bash external completion → session acknowledgement | 6.516s average | 1.618s | 75.2% | 4.03× |
| Execution callback received → router durable receipt | 4.341s average | 0.682s | 84.3% | 6.36× |

The input was accepted and the complete two-model-turn/one-command run returned to idle in 16.041 seconds. Every operation and callback completed on its first processing attempt. The two LLM completion intervals were 2.777s and 4.542s; the bash interval was 1.618s. Callback network travel remained small (168–185ms for LLM, 390ms for execution).

The remaining LLM post-callback time was 2.592s and 4.374s. It now contains the authoritative gateway detail/result fetch, D1 fencing/state transitions and Durable Object completion admission—not Queue scheduling. Removing the result-fetch hop would require the separate gateway callback-payload change discussed earlier; it was intentionally not folded into this Worker-side optimization. This is a single production smoke sample, so it verifies the architecture and direction rather than establishing a latency SLO.

Date: 2026-09-19  
Session: `ses_14193c8e-9098-4203-8ffe-1771d64608d7`  
Model: `gpt-5.6-sol`, medium reasoning  
Sample: 19 LLM operations, 15 bash operations, five active runs

## Executive result

The five active runs took **437.234 seconds (7m 17.2s)** from durable input receipt to the final operation being acknowledged by the session. Time between test scenarios was excluded.

| Critical-path bucket | Time | Share |
|---|---:|---:|
| Gateway-reported LLM provider requests | 94.441s | 21.6% |
| LLM gateway/network outside provider requests, before job completion | 7.863s | 1.8% |
| Execution gateway + machine command runtime | 83.356s | 19.1% |
| Managed-agents completion/orchestration path | **251.574s** | **57.5%** |

The control-plane number is materially too high. Raw callback network travel was only about 0.1–0.2 seconds. The dominant delay was the durable callback/Queue processing chain after an external job was already complete.

The execution bucket cannot yet be split into gateway overhead versus subprocess runtime because this dataset retained job completion but not the process-spawn timestamp. It includes two deliberate 20-second sleeps and one approximately 20.7-second filesystem search, so it should not be read as 83 seconds of execution-gateway overhead.

## Per-run result

| Run | Purpose | Wall | LLM provider | Execution + command | Non-provider/control overhead |
|---|---|---:|---:|---:|---:|
| `run_1` | Initial project setup | 188.628s | 44.002s | 35.460s | 109.166s (57.9%) |
| `run_15` | Context-dependent follow-up | 72.770s | 19.674s | 2.409s | 50.687s (69.7%) |
| `run_23` | Two-message steering | 105.737s | 20.225s | 23.099s | 62.413s (59.0%) |
| `run_35` | Graceful cancellation | 41.270s | 2.043s | 20.548s | 18.679s (45.3%) |
| `run_40` | Resume and verification | 28.829s | 8.497s | 1.840s | 18.492s (64.1%) |

The steering and cancellation runs each intentionally executed `sleep 20`. They validate lifecycle behavior but are not representative of productive command time.

## LLM path

Across 19 model turns:

| Interval | Mean | Median | p90 | Total |
|---|---:|---:|---:|---:|
| Complete LLM operation: worker reservation → session acknowledgement | 13.735s | 13.287s | 19.056s | 260.960s |
| Gateway-reported provider request | 4.971s | 4.068s | 9.287s | 94.441s |
| Everything outside provider request | **8.764s** | **8.591s** | **10.769s** | **166.519s** |
| Operation reservation → gateway completion, less provider duration | 0.414s | 0.392s | 0.570s | 7.863s |
| Gateway completion → webhook received | 0.106s | 0.104s | 0.131s | 2.012s |
| Webhook received → event marked processed | 2.717s | 2.456s | 3.363s | 51.632s |
| Gateway completion → session acknowledgement | **8.350s** | **8.207s** | **10.379s** | **158.656s** |

The current LLM completion route is:

```text
gateway completes
  → signed webhook
  → persist webhook event in D1
  → Queue delivery #1
  → bind event to operation and persist
  → Queue delivery #2
  → fetch result from gateway
  → Durable Object acceptCompletion
  → mark operation delivered in D1
```

Eighteen of 19 LLM operations had two operation-processing attempts: the initial pending check and the callback-triggered attempt. This is expected recovery behavior, but it also leaves stale delayed Queue messages that later become no-ops.

## Bash path

Across 15 commands:

| Interval | Mean | Median | p90 | Total |
|---|---:|---:|---:|---:|
| Complete bash operation: worker reservation → session acknowledgement | 12.073s | 6.551s | 33.403s | 181.094s |
| Execution gateway + command | 5.557s | 1.840s | 20.585s | 83.356s |
| Execution complete → session acknowledgement | **6.516s** | **5.108s** | **13.165s** | **97.738s** |
| Execution complete → callback Worker received | 0.183s | 0.163s | 0.293s | 2.745s |
| Callback received → callback router's durable receiver admission recorded | 4.341s | 3.811s | 6.156s | 65.117s |

The current execution completion route is:

```text
machine command completes
  → execution gateway persists result
  → signed webhook
  → callback router persists event in D1
  → Queue delivery #1
  → private RPC into bash worker
  → bash worker binds terminal job in D1
  → Queue delivery #2
  → fetch result from execution gateway
  → Durable Object acceptCompletion
  → mark delivery in D1
```

The callback router's D1 `delivered_at` marker is written after its RPC returns, while the bash Queue can begin concurrently. Therefore `callback router` and `result fetch/session delivery` are not strictly additive per job. The unambiguous critical interval is execution completion to session acknowledgement: 6.516 seconds on average.

Cloudflare Queue analytics independently reported approximately **4.36 seconds average read lag** for the execution-callback Queue during the test window, matching the 4.34-second callback-router measurement. LLM/bash Queue analytics were not used in the critical-path calculation because their figures include deliberately delayed, already-obsolete pending retries.

## What is and is not expensive

- Initial input admission, harness handling and first operation reservation took only **8–11ms per run** in this sample.
- Gateway time outside the actual LLM provider request was about **414ms per model turn** before the gateway marked the job complete.
- LLM callback network travel averaged **106ms**.
- Execution callback network travel averaged **183ms**.
- Post-completion durable processing averaged **8.35s per LLM turn** and **6.52s per bash call**.

This points to Queue scheduling and the two-stage durable completion pipelines—not the number of HTTP hops alone—as the primary latency source. D1 and RPC time are currently combined with Queue wait inside several intervals, so this dataset cannot assign an exact standalone D1 cost. The very fast initial admission path is evidence that D1/service-binding access is not inherently adding seconds on the hot path.

## Critical-path accounting method

For each run, operations are ordered by their worker `created_at`. The critical end of an operation is the next operation's `created_at`, or the final operation's `delivered_at`. This avoids double-counting delivery bookkeeping that continues briefly after the Durable Object has already acknowledged a completion and started the next operation.

There were 4.865 seconds of such overlapping post-acknowledgement bookkeeping across the test. A naive sum of operation durations double-counts it. The 437.234-second critical-path total above does not.

Provider time comes from each retained response's gateway-reported `durationMs`. Execution time is bash-worker reservation through the execution gateway's signed `completedAt`. Callback, event-processing and delivery times use D1 timestamps from the three operation/callback databases. Input start uses the session's durable `receivedAt` receipt.

## Recommended optimization order

1. **Collapse each completion path from two Queue hops to one.** For LLM, the event consumer can bind the event, fetch the terminal result and deliver it without enqueueing a second operation message. For bash, authenticate/persist in the common callback Worker and durably admit into the bash worker directly, retaining D1 recovery if the RPC fails. This targets the largest measured delays while retaining idempotency and recovery.
2. **Add a safe inline fast path after durable persistence.** Attempt immediate processing inside the webhook/RPC invocation, while keeping the existing D1 due-row scan and Queue as recovery. A timeout or failure leaves retained work for retry. This can approach sub-second completion delivery without weakening durability, but webhook response budgets and large result fetches need care.
3. **Test Queue consumer settings `max_batch_size: 1` and `max_batch_timeout: 0`.** They are currently 10 and 1 second. Cloudflare permits a zero-second batch timeout; lower batching reduces latency at the cost of more consumer invocations. This alone will not remove both Queue hops or all observed scheduling delay. See [Cloudflare Queue batching](https://developers.cloudflare.com/queues/configuration/batching-retries/).
4. **Avoid eager pending polls when a reliable callback exists.** Most LLM operations perform an initial pending Queue read, schedule a 60-second retry, then complete through the callback. The delayed no-op retry adds Queue traffic and obscures queue-lag metrics. Keep scheduled D1 recovery, but make the callback the normal wake-up.
5. **Instrument before and after each change.** Enable Workers tracing and add an operation/session correlation ID plus application stage timestamps. Cloudflare tracing automatically records fetch and binding spans, though external trace propagation and some non-I/O timing have documented limitations. See [Workers traces](https://developers.cloudflare.com/workers/observability/traces/) and [known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).

As a directional estimate, eliminating only the first post-callback Queue stage would target roughly 2.7 seconds per LLM completion and 4.3 seconds per bash completion—about **116 seconds across this sample**, before accounting for overlap. A fully optimized durable fast path targeting approximately one second from external completion to session acknowledgement could plausibly remove over 200 seconds from this 437-second sample. That second figure is a target scenario, not a measured guarantee.

## Instrumentation needed for exact attribution

Add timestamped structured spans for:

- Session input received, harness handler start/end, operation requested and provider RPC acknowledged.
- Operation-worker reservation committed, upstream POST start/end, Queue send and Queue consumer start.
- Gateway admission, provider request start/end, machine dispatch, process spawn/exit, result commit and webhook response.
- Webhook received/signature verified/persisted, receiver RPC start/end, result GET start/end, Durable Object completion start/ack and D1 delivery update.

Use a single `traceId`, `sessionId`, `operationId`, `submissionId` and upstream `jobId` throughout. `performance.now()` is suitable for intervals inside one invocation; cross-service analysis should use UTC wall-clock timestamps and tolerate clock skew. Queue `lagTime` metrics are available through Cloudflare's GraphQL Analytics API, but per-operation application timestamps remain necessary because retries and recovery messages share the same queues. See [Cloudflare Queue metrics](https://developers.cloudflare.com/queues/observability/metrics/).

## Scope

This is one controlled session, not a statistically representative benchmark. The sample includes cold starts, package installation, one command that searched the home directory, two deliberate sleeps, an initial project-generation error and recovery, and test-driver pauses excluded from active-run time. The conclusions are strong enough to identify the completion queues as the primary bottleneck, but changes should be validated over multiple sessions and regions.

Machine-readable calculations remain in `/tmp/managed-agents-live-e2e.Ds9pLT/latency-analysis.json` while that temporary directory exists.
