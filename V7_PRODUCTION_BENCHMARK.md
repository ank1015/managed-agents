# V7 final production cost benchmark — 2026-09-20

## Result

Deployment and the full end-to-end test passed. **14 LLM jobs and 10 bash jobs succeeded; all 24 callbacks returned HTTP 204 on their first attempt.** Project creation, same-session context recall, batched steering, cancellation at the turn boundary, held messages and resume all passed. No application failure, retry or alarm invocation was observed.

Estimated gross Cloudflare execution usage is **$0.000282 per 10 model responses**. A more conservative budget, adding an alarm-write reserve and expected sampled success logs, is **$0.000307 per 10 responses**, or **$0.31 per thousand such workloads**. That budget is approximately **80% below the earlier $0.001524 estimate**, and **41% below the previous v6 $0.000519 estimate**. Model fees and retained storage are separate. This is approximately a 5× improvement over the earlier quoted budget, not 10×.

The test itself had 14 responses, not 10: its observed-usage execution estimate is **$0.000394**, or **$0.000430 with the conservative reserve**. Prices are before monthly allowances and the account minimum; these are usage valuations, not actual invoice line items.

## Deployment and test

- Session: `ses_ea3d7c24-07ea-4e92-a19f-d976267f9de3`.
- Harness: `minimal-bash/v7`; OpenAI `gpt-5.6-sol`, medium reasoning.
- Machine: `75fc68a7-de9f-451f-ae21-292aa86ad032`.
- Directory: `/Users/notacoder/Desktop/test`, verified empty before starting.
- Client window: **15:04:00–15:06:25 UTC**; observation ended at 15:06:27.
- Five logical runs in one session, 31 conversation messages, 11 automated behavioral assertions.
- [Deployment versions, bindings and drain verification](DEPLOYMENT.md).

The model built a strict TypeScript greeting CLI with local dependencies, tests, README and scripts. The follow-up added trimmed named input, default/blank fallback and Unicode coverage. Two steering messages changed the default to `TypeScript` and added `npm run verify`. Cancellation completed the in-flight tool call, then stopped; resume processed the held request and returned idle.

Independent checks after the measured cloud window passed: typecheck, four tests, build and default/trimmed/blank/Unicode CLI outputs. No manual source repair was needed. Node/npm were available without exporting PATH. The conversation-only recall marker was recalled from history and was absent from project source/README/package metadata.

Final session state: idle, no active operation, pending message, processing block or error. Both deliberate 20-second sleeps were preserved to match the earlier steering/cancellation test. Their 40 seconds are execution time, not orchestration.

## Usage measured for the entire 14-response test

| Resource | Usage / evidence |
|---|---|
| Standard Worker requests | 146 known external requests; 153 in the sampled analytics aggregate |
| Standard Worker CPU | 307.508 ms in analytics |
| API requests | 122, including **109 observation GETs** |
| D1 directory | 158 rows read; **15 rows written**; 135 query batches |
| Tested Durable Object requests | 146 in complete live tail; 144 in script-filtered adaptive analytics |
| DO duration | 19.723 active seconds; **2.524527 GB-seconds** |
| DO CPU, not billed as Standard Worker CPU | 279.160 ms |
| DO SQLite | **2,636 rows read; 271 rows written** |
| Queues / adapter D1 | None in this architecture; no old adapter D1 activity reported |
| Explicit application logs | **0 observed** across 326 live-tail invocations |
| Retained database size | Not measured; storage analytics returned no rows |

The estimate uses 153 Standard Worker requests conservatively, and the 146 directly observed DO requests. Service-binding invocations are not each an additional Standard Worker request charge; CPU still contributes. DO CPU is not charged a second time under Workers CPU pricing. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

### Cost normalized to 10 model responses

This scales usage by 10/14, yielding about 7.14 bash executions. Like the earlier budget, it includes heavy test polling and several run boundaries. It is not a separately measured continuous 10-turn run.

| Service | Earlier quoted budget | Previous v6 | V7 observed-usage estimate |
|---|---:|---:|---:|
| Workers | $0.000071 | $0.0000388 | $0.0000372 |
| D1 | $0.000501 | $0.0000101 | $0.0000108 |
| DO requests, duration and SQL | $0.000707 | $0.0003301 | $0.0002336 |
| Queues | $0.000005 | $0 | $0 |
| Logs | $0.000240 | $0.0001404, invocation proxy | $0 observed; see caveat below |
| **Total execution** | **$0.001524** | **$0.0005195** | **$0.0002816** |
| Additional V7 alarm/log reserve | Not separately identified | Not separately identified | **$0.0000253** |
| **Practical V7 budget** | | | **$0.0003069** |

Without the reserve, the comparison is approximately 81.5% cheaper than the quoted budget and 45.8% cheaper than v6. With it, use the more conservative **79.9% and 40.9% savings**. Previous estimates were already approximate; adding a reserve only to V7 makes this comparison conservative.

#### Alarm and log reserve

Cloudflare bills each `setAlarm()` as a row write. We did not instrument a separate production alarm-call counter. The reported 271 SQL writes match the direct SQL replay exactly, so the budget does not assume alarm setup is free: it reserves **35 additional writes for the entire test**, one for each input submission attempt or callback admission. Existing alarms can be reused, so this is a reserve, not an observed count. There were no observed retries, continuations or alarm invocations. The allowance does not cover arbitrary failure storms. [Alarm billing](https://developers.cloudflare.com/durable-objects/platform/pricing/#sqlite-storage-backend).

All five deployed services have automatic invocation-log persistence disabled. Thus 326 live-tail invocations are **not 326 persisted log events**. This session emitted zero explicit events. An attempt to query persisted-log aggregation was denied by the available credentials, so zero observed logs is not a metered ingestion assertion. The healthy-workload reserve uses 1% of session creation, 11 status transitions and two summaries per operation: approximately **0.43 events per normalized workload**, costing about $0.00000026. Errors are unsampled and would add cost. [Logging policy](packages/diagnostics/README.md), [Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing).

### Scaling and storage

At gross usage rates, 1,000 normalized workloads are approximately **$0.307 execution**. Reusing the previous, deliberately unchanged assumption of 1 MB retained DO data plus 32 KB D1 metadata for one month adds **$0.224 per thousand**, for **$0.531 combined**. Actual retained sizes were not measured; transcript JSON size is not database size.

With otherwise unused paid-plan allowances, no other workloads and that assumed 30-day storage retention, rough account totals including the $5 base are:

| Normalized workloads/month | Estimated account total |
|---:|---:|
| 1,000 | $5 |
| 10,000 | $6.15 |
| 100,000 | $25.78 |
| 1,000,000 | $467 |

Allowances are account-wide. Older retained namespaces and other apps also consume storage/allowances; these totals do not include them. Longer retention, longer conversations, retries, different tool ratios and different polling change the result. No 10× total cost reduction is claimed.

Rates checked on 2026-09-20: Workers $0.30/million requests and $0.02/million CPU-ms; DO $0.15/million requests and $12.50/million GB-s; D1/DO SQLite $0.001/million reads and $1/million writes; D1 storage $0.75/GB-month and DO storage $0.20/GB-month; logs $0.60/million events. Included allowances and DO billing-unit rounding are applied in the monthly projection. [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing).

The LLM gateway separately reported **$0.1209232 for all 14 responses**, or $0.0863737 normalized to 10. Model fees, execution-machine costs, both upstream gateways' infrastructure, domains and taxes are excluded from the managed-agents Cloudflare estimate.

## Isolating the SQLite optimization

Production reported 271 SQL row writes, versus 454 in the earlier 15-response/11-bash v6 test. Normalized, that is **193.6 versus 302.7 writes per 10 responses: 36.0% fewer**. Different model decisions make this an approximate comparison.

For a controlled check, the exact new test's nine input events and 24 gateway completions were replayed locally through workerd, once with the previous storage layout/counter behavior and once with v7. Both reproduced the **identical full transcript, operation IDs, statuses and final state** without calling external gateways.

| Exact-workload local SQL replay | Before | V7 |
|---|---:|---:|
| SQL row writes, including schema creation | **428** | **271** |
| Transactions, including schema bootstrap | **68** | **68** |
| Inbox events | 33 | 33 |
| Conversation messages | 31 | 31 |

That isolates a **36.7% SQL-write reduction** without changing the transaction boundaries. An initial preliminary count of 427 omitted the old context index's one schema-creation write; the final 428 includes it. The existing smaller regression test remains 100 → 63 writes, excluding schema bootstrap.

The replay does not measure production alarms, network latency, D1 status writes, CPU billing or observation reads. It restores the prior storage choices in a local measurement fixture, not a second production deployment. SQL writes remain the largest execution-cost component even after the reduction.

Removing the 109 observation GETs in a conservative counterfactual lowers observed-usage execution from $0.000282 to about **$0.000245 per 10 responses**. This subtracts their known API/DO request costs, API CPU and D1 lookup reads, while retaining all DO duration and SQLite reads because those could not be attributed reliably. A real UI still needs observation; this is not another measured run.

## Latency: no improvement demonstrated by this sample

| Metric | Previous v6 | V7 |
|---|---:|---:|
| Active run wall time, excluding gaps/poll detection | 136.864 s | **128.689 s** |
| LLM processing | 57.040 s | 58.602 s |
| Additional LLM gateway lifetime | 1.483 s | 1.361 s |
| Execution gateway lifetime, including 40 s deliberate sleeps | 66.465 s | 53.578 s |
| Managed-agents residual time | **11.876 s** | **15.148 s** |
| Mean LLM completion → callback acknowledgement | 388 ms | 561 ms |
| Mean bash completion → callback acknowledgement | 373 ms | 462 ms |
| Fixed 10-LLM/7-bash post-completion path | 6.659 s | 9.248 s |

The shorter overall run does not prove lower orchestration latency: the model used one fewer LLM/bash pair, and upstream execution was shorter. **Managed-agents residual time was higher in this sample.** We did not establish whether placement, cold-start or network variation caused it. The cost optimization worked; a latency improvement was not demonstrated. Cold session creation took 1.948 seconds client-side.

The two 20-second sleeps are contained in execution time, not the 15.148-second residual. The DO's 19.723 active seconds are a different billing measurement and must not be added to active workflow time as another latency bucket.

## Measurement limits and evidence

- Cloudflare data arrived gradually after the run. Narrow test-window queries undercounted work; the final analytics window starts 15:04 UTC and extends through collection at 15:18 UTC. No additional benchmark API/DO calls were made after 15:06:27. DO data is filtered to this session; D1 is directory-wide.
- Adaptive analytics are estimates, not exact invocation ledgers: Standard Workers reported 153 versus 146 known external requests. Script-filtered DO analytics reported 144 versus 146 in complete live tail; a broader adaptive query reported 163. The budget uses 153 and 146 respectively. Sampling/aggregation prevents interpreting these mismatches as duplicate execution. Independent gateway records verify exactly 24 jobs and deliveries.
- Final DO SQL/duration and D1 totals were stable across repeated collections. No live-tail disconnect, exception or application failure was observed.
- Serialized final transcript rows occupied 65,121 bytes, not a measured SQLite database size. No storage saving is claimed.
- No production fault injection or load test was performed. One session cannot establish tail-latency, concurrency or reliability guarantees.

Local evidence: `/tmp/managed-agents-v7-benchmark.ruEy4L/`: `report.json`, `gateways.json`, `analysis.json`, `metrics-run.json`, `metrics-wide.json`, `metrics-do-wide.json`, `cost.json`, `replay-profile.json`, corresponding scripts and deployment/check logs. Temporary evidence contains private conversation/provider data and should not be published indiscriminately. The repository reports contain no credentials.
