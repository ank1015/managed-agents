# Cloudflare cost estimate — 2026-09-19

## Bottom line

A **10-model-turn workload with about 7 bash calls**, resembling the latest test, budgets approximately **$0.00152 in Cloudflare usage**, plus **$0.000224 for one month of assumed retained storage**, before included quotas and billing-unit rounding. Combined: **$0.00175, or 0.175 US cents**. This is a usage valuation, not an invoice for an individual run.

With the current background recovery jobs, an otherwise unused Workers Standard paid account, and the storage assumptions below, estimated monthly bills are approximately **$6 for 1,000 runs**, **$7 for 10,000**, and **$82 for 100,000**. Other applications on the account consume the same product allowances. These figures exclude the separate LLM/execution gateways' infrastructure, model charges, machines, domains and taxes.

No production code or configuration was changed for this analysis. Cloudflare Analytics was queried read-only.

## Measurement and attribution

The [latest production test](E2E_RETEST_REPORT.md) had 13 model responses and 9 bash calls across five logical runs in one persistent session. Normalizing it to 10 responses is a budgeting yardstick, **not a measurement of one continuous 10-turn run**. A longer conversation, larger results, extra tools, retries or different polling behavior will change usage.

Analytics window: **2026-09-19 10:39:30–10:43:00 UTC**. This covers the test plus a small margin. Worker and D1 metrics cover only this repository's five scripts/four databases, but include background recovery for older sessions. DO metrics below are filtered to the tested session `ses_9a26cca8-7a00-42bc-bff9-9bb1a81458d6`. These are analytics measurements, not invoice line items; periodic collection, window boundaries and adaptive sampling limit exact attribution.

### Workers

| App | Analytics requests | CPU milliseconds | What it does |
|---|---:|---:|---|
| agent-api | 191 | 378.501 | Session creation, inputs and transcript/pending-message reads |
| harness-minimal-bash, ordinary Worker | 4 | 14.656 | Scheduled status recovery; session DO usage is separate below |
| llm-gateway-workers | 21 | 177.955 | LLM submission, callbacks, result retrieval and completion delivery |
| tool-pi-bash-workers | 11 | 63.955 | Bash submission, result retrieval and completion delivery |
| execution-gateway-callback-workers | 13 | 44.431 | Signed callback admission and routing |
| **Total** | **240** | **679.498** | |

Do not multiply all live-tail invocations by the Worker request rate. The tail captured 503 invocations, including DO calls and service-binding RPC. Its slightly different window included 197 API calls: 184 GETs and 13 POSTs. The numerous GETs were functional-test observation/pagination traffic. A less aggressively polling application can use less.

### Storage and Durable Object compute

| Service | Measured usage in window |
|---|---|
| Session-directory D1 | 344 rows read; 148 rows written; 276 query batches |
| LLM-operations D1 | 322 rows read; 311 rows written; 195 query batches |
| Bash-operations D1 | 143 rows read; 144 rows written; 85 query batches |
| Execution-callback D1 | 53 rows read; 45 rows written; 40 query batches |
| **All four D1 databases** | **862 rows read; 648 rows written; 596 query batches** |
| Tested session DO | 222 RPC requests; 18.136 active seconds; 2.3214 GB-seconds |
| Tested session's SQLite | 6,421 rows read; 800 rows written |

DO CPU was also reported as 444.697 ms, but it is **not added as another Standard Worker CPU charge**: the DO compute model uses requests and active duration. The object's measured active time is far shorter than the task's 181.931 seconds. The runtime returns between asynchronous operations instead of holding an event open for the whole LLM/command execution.

Five Queue consumer invocations were observed in the live tail. Queue metered-operation counts were not collected; this estimate assumes approximately 15 operations for those deliveries. Similarly, the 503 tail invocations with no custom console messages are a log-volume proxy, not a measured Workers Logs ingestion count.

The final transcript's serialized message-page data was 69,186 bytes. **That is not SQLite database size**: runtime inbox/outcomes, duplicated result representations, indexes, migrations, internal metadata and page allocation also occupy space. Per-session database bytes were not measured. Storage below is an explicit budget assumption.

## Pricing model

Official public pricing checked on 2026-09-19; assumes Workers Standard, not a negotiated/legacy plan.

| Dimension | Monthly included amount | Rate above inclusion |
|---|---:|---:|
| Workers requests | 10 million | $0.30 / million |
| Workers CPU | 30 million ms | $0.02 / million ms |
| D1 rows read / written | 25 billion / 50 million | $0.001 / million reads; $1 / million writes |
| D1 storage | 5 GB | $0.75 / GB-month |
| DO requests | 1 million | $0.15 / million |
| DO active duration | 400,000 GB-seconds | $12.50 / million GB-seconds |
| DO SQLite rows read / written | 25 billion / 50 million | $0.001 / million reads; $1 / million writes |
| DO SQLite storage | 5 GB-month | $0.20 / GB-month |
| Queues operations | 1 million | $0.40 / million |
| Workers Logs events | 20 million | $0.60 / million |

The account subscription is $5/month, not $5 per app. Standard Workers have no wall-duration or egress charge; waiting on I/O is not CPU. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

Service bindings do not add a separate per-hop request fee; actual execution still consumes resources. [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)

DOs bill active/non-hibernatable time at the allocated 128 MB; eligible idle time is not charged. The published page specifies rounding excess compute usage up to million-unit blocks; the monthly calculation applies that rounding to DO requests/duration. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

D1 bills rows, not SQL statement count. Index maintenance can add row writes, already reflected in measured `rowsWritten`. Its allowances are account-wide across D1 databases; this model applies the separately listed DO SQLite allowances to that product. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Small Queue messages normally require a write, read and delete; retries add operations. Our Queue payloads are work identifiers, not entire model contexts. [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)

Invocation logs and custom console events count toward log ingestion. [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)

## Rounded 10-turn budget

The following rounds the test toward a convenient, somewhat cautious planning workload. It retains substantial polling overhead. It is not a maximum, SLO, or guaranteed cost.

| Resource | Budget per 10 model turns / ~7 bash calls | Gross usage value |
|---|---|---:|
| Workers | 200 requests; 550 ms CPU | $0.000071 |
| D1 | 1,000 reads; 500 writes | $0.000501 |
| DO compute + SQLite operations | 180 requests; 2 GB-s; 5,000 reads; 650 writes | $0.000707 |
| Queues | 12 operations | $0.0000048 |
| Logs | 400 events | $0.000240 |
| **Execution subtotal** | | **$0.001524** |
| Retained storage | 1 MB DO SQLite + 32 KB D1, for a full month | $0.000224 |
| **Total usage value** | | **$0.001748** |

MB/GB here are decimal. Storage is assumed total allocated storage per newly created session containing this workload, not just message text. Reusing a session changes fixed overhead; accumulating longer histories changes it again. Included monthly amounts are intentionally not allocated to individual runs in this gross-value table.

## Monthly forecast, including background work

Assumptions:

- One newly retained session per 10-turn workload; 30-day steady-state retention gives N sessions retained on average for N runs/month. **The application does not currently enforce this retention policy.** First-month storage ramps up; indefinite retention accumulates across months.
- Current status-recovery cron continuously fills its maximum batch of 100 sessions/minute. Four cron triggers run every minute. This deliberately budgets the ongoing idle refreshes as well as task work; a small amount of cron traffic is also present in the per-run measurement, so the estimate is mildly conservative there.
- All product quotas are available to this workload. In reality the upstream gateways/other projects may share and consume them. No account-wide invoice/subscription audit was performed.
- Small-payload, successful work at approximately the measured shape; no load-driven retries or major payload growth.

| Runs per month | Cloudflare estimate including $5 base | Model cost extrapolated from sample, separately |
|---:|---:|---:|
| 1,000 | **$5.60** | $96.85 |
| 10,000 | **$6.90** | $968.54 |
| 100,000 | **$82.31** | $9,685.45 |
| 1,000,000 | **$1,651.08** | $96,854.46 |

Amounts are spreadsheet-style model outputs, **not cent-accurate forecasts**. Quote approximately $6, $7, $80–85 and $1.65k respectively. Large-volume figures are pricing extrapolations, not evidence that the current deployment has been capacity-tested or can fit every database's storage limits without partitioning.

At 100,000 runs, the modeled Cloudflare breakdown is: $5 base; $3.63 Workers; $17.28 D1 row usage; $3.30 DO compute; $19.32 DO SQLite rows; $0.08 Queues; $14.70 logs; $19 DO retained storage. D1 storage remains below its allowance in this case.

The sample gateway reported $0.1259108 for 13 LLM responses, or **$0.096854 per ten**. This is not a fixed price per turn: token counts, reasoning, cache hits and model choice matter. It excludes execution machines and both upstream gateway applications' infrastructure. Those applications are outside this repository's measured service set.

### Background idle refreshes

`apps/harness-minimal-bash/src/status.ts` selects up to 100 ready sessions every minute, including idle sessions, and calls their DOs to republish status. A read-only audit of **10:45–10:50 UTC**, after completion, confirmed that all five retained idle sessions were refreshed five times each.

The 25 refreshes generated 100 D1 row writes and 25 DO SQLite row writes. Measured DO duration averaged 0.03863 GB-s per refresh. At the current batch cap over 30 days this projects to:

- 4.32 million DO refresh requests;
- 17.28 million D1 row writes and 4.32 million DO SQLite writes;
- approximately 166,901 GB-s of DO duration, assuming similar per-refresh latency;
- approximately 4.49 million invocation logs including the four cron handlers.

For budgeting, background Worker CPU is conservatively assigned 4 million ms/month; it is not a measured production month. This idle-work duration could change with geography or contention. It consumes quotas even when users submit no new tasks. The refresh cap means fleet-wide work saturates at 100/minute, rather than every stored session being refreshed each minute.

Removing this particular idle refresh load would reduce the same modeled monthly totals to about $5 / $6.15 / $57.13 / $1,625.90. That is a **what-if estimate**, not a change made here.

## What matters next

1. **Row writes dominate marginal orchestration cost.** Fewer redundant durable transitions can improve both cost and latency; preserve correctness/idempotency when consolidating them.
2. **Idle status refreshing is real background usage.** Consider refreshing only sessions requiring repair rather than continually cycling through completed sessions.
3. **Retention must be an explicit decision.** Successful submission payloads are cleared from runtime outbox, but history, outcomes, inbox and worker metadata remain. For example, 100,000 retained sessions at 1 MB each use 100 GB of DO storage, even if no new tasks run.
4. **Large contexts/results change the model.** Chunked SQLite avoids row-size limits, not per-chunk writes, reads, JSON processing or stored bytes. Ten turns is insufficient to forecast a workload with multi-megabyte payloads.
5. **Logs and frontend polling matter at scale.** Current observability is enabled on every app. Sampling, incremental reads and sensible polling can reduce overhead without affecting core orchestration.
6. **Exact concurrent per-run attribution needs correlation.** D1 query `meta.rows_read/rows_written`, SQL cursor counters, session storage-size snapshots and structured run IDs can improve attribution. DO active duration should come from the provider's metering, not summing overlapping RPC wall times. Analytics already supplies useful per-object DO measurements and script/database aggregates, but aggregates cannot isolate overlapping runs in shared D1 databases.

General monthly arithmetic: `subscription + sum(max(0, monthly usage - inclusion) × rate)`, applying documented billing-unit rounding where relevant. Add `average retained GB × storage rate` after storage inclusions. Do not subtract the same account allowance once per app or per run.

## Evidence

- [Functional/latency test report](E2E_RETEST_REPORT.md)
- Local analysis directory: `/tmp/managed-agents-cost-analysis.5uLzHM`
- `cloudflare-metrics.json`: raw narrow-window read-only analytics results.
- `idle-metrics.json`: post-test idle-window analytics results.
- `cost-model.json`: input assumptions, gross costs and monthly arithmetic.
- `collect.mjs` / `calculate.mjs`: reproduce those read-only queries/calculations; credentials are read locally and never written to the outputs.

Cloudflare analytics supports DO active-duration and SQLite-row metrics directly. [DO analytics documentation](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
