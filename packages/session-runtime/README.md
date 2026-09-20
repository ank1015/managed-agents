# Session runtime

A replay-based session engine inside a Cloudflare SQLite Durable Object. It owns durable input admission, read-only harness planning, operation submission, atomic local commit, callback admission, and inbox recovery. Operation workers own accepted jobs and reliable result delivery.

Use one `SessionDriver` per DO activation; do not mutate its database or create another processor alongside it. The host supplies authentication, routing, Worker bindings and a best-effort D1 status publisher.

## Execution flow

1. Admission snapshots/validates the input, arms a recovery wakeup, and commits its ordered inbox entry. Identical event IDs/content return the original receipt; changed content conflicts.
2. `prepareNext()` reads the oldest pending input and calls synchronous read-only `harness.handle`. It validates and caches an in-memory `{ changes, operations, status? }` plan. **No writes and no outgoing-payload storage.**
3. The driver submits the independent operations outside the admission lock, with bounded concurrency (default 8). New inputs/callbacks can still be durably admitted.
4. Once all submission outcomes are known, `commit(plan, receipts)` atomically applies harness changes, stores accepted-job receipts, queues rejected/immediate completions, consumes the source input, and removes the receipt for any completion being consumed.
5. An explicit status intent is published after commit. The loop advances to the next inbox entry.

A batch can contain any number of independent operations; the concurrency setting is not an operation-count limit. Each operation has a stable harness key. IDs are SHA-256 over `[sessionId, harnessId, harnessVersion, inputSequence, key]`, prefixed with `replay-v1:<sequence>:`. Both wire correlation fields (`operationId`, `submissionId`) use this ID. There is no independent random ID or pre-dispatch write.

## Recovery and tradeoffs

| Boundary | Behavior |
|---|---|
| Preparation fails | No submissions or local changes; input retries, then blocks on repeated handler failure. |
| Some workers accept, another times out | Retain source input; do not commit local changes or advance later handlers. Retry the unknown submission. |
| Warm retry | Keep prepared plan and resolved sibling receipts in memory. |
| Restart before commit | Reconstruct the same plan and replay all submissions with the same IDs. Workers must recover the same jobs/rejections, not execute new jobs. |
| Local commit fails after acceptance | Roll back ALL local changes; accepted external effects remain. Replay/retry the same transition, never invent new IDs. |
| One sibling definitively rejects | Commit accepted siblings plus a synthetic failed completion for the rejected sibling. This is not a distributed all-or-nothing transaction. |
| Callback arrives before local commit | Validate against the cached/reconstructed head plan and queue it in the ordinary inbox. It cannot overtake its source input. |
| Callback/receipt repeats | Inbox event hash deduplicates it even after its body and pending receipt are deleted. Changed provider/job/outcome conflicts. |
| Accepted job has no callback yet | No runtime polling/alarm just for that job. The provider owns recovery: gateway webhook retries for both stateless LLM and bash adapters. |

All-or-nothing applies to **local SQLite commit**, not remote side effects. The submission barrier can delay steering/cancellation handlers behind an ambiguous batch member. Workers must retain idempotency for the full recovery horizon. The harness version, resolved config and committed state must reconstruct identical operations; changing code in an active namespace breaks that premise. Neither replay nor job deduplication guarantees exactly-once arbitrary machine effects.

Accepted/rejected siblings do not require durable per-attempt receipts. This reduces writes at the cost of repeated idempotent submissions after activation loss. The source input remains durable until commit. Large contexts are rebuilt from harness history plus proposed messages, not an outbox.

## Storage

| Table | Data / lifetime |
|---|---|
| `runtime_session` | Singleton identity, resolved config and created time; immutable after initialization. Identity/config are cached, frozen per activation. |
| `runtime_inbox` | Event ID, sequence, admission time, canonical hash, inline pending JSON body, consumed time; retry deadline/count/error/blocked state on the head input. Consumption clears body and retry metadata. Hash/receipt rows remain. |
| `runtime_pending_operations` | Operation ID, source input sequence, key, provider and accepted job ID. Removed in the completion-handling commit. No request or outcome. |

Removed: `runtime_outbox`, `runtime_operations` historical outcome ledger, and `runtime_progress`. There is no output-event table, DO status table, operation lease, per-operation retry schedule or reconciliation loop.

The v7 layout uses `runtime_inbox.sequence INTEGER PRIMARY KEY` (the rowid), plus a unique non-null event ID and the pending-input partial index. Admission reads `MAX(sequence) + 1` inside the insertion transaction; there is no separate counter write. The integer primary key makes the maximum an end-of-tree lookup, not a history scan. Consumed inbox rows retain the high-water mark as well as deduplication receipts. **Do not delete the highest sequence row or clear this table** without first designing a durable high-water mark; sequence reuse would also reuse operation identities. `runtime_pending_operations` is `WITHOUT ROWID`, keyed directly by operation ID rather than a rowid plus a separate primary-key index. Admission/commit boundaries, foreign keys, retries and deduplication are unchanged.

Operation inputs allow 8 MiB UTF-8 JSON and exist only in memory. Outcomes allow 1,900,000 bytes; workers must convert oversized gateway results to small terminal failures before delivery. Inbox JSON, event ID and hash must fit a 1,950,000-byte storage budget, leaving room below Cloudflare's 2 MB row limit. Oversized direct inputs are rejected atomically without allocating a sequence. All JSON is inline: there are no chunk tables, manifests or chunk helpers. There is no R2 reference layer or retention policy for consumed input hashes/harness history. Inline storage was deployed in v5, with completion-admission code changes deployed in v6. V7 changes the fixed SQLite layout without adding tables and is deployed in another fresh namespace. See the [deployment guide](../../DEPLOYMENT.md). Retained v4 chunked storage is not compatible. See the [deployment guide](../../DEPLOYMENT.md).

## Hosting

```ts
this.driver = new SessionDriver(ctx.storage, harness, {
  providers: { llm: llmProvider, "tool-pi-bash": bashProvider },
  waitUntil: promise => ctx.waitUntil(promise),
  onStatusChange: status => publisher.publish(sessionId, status),
});
async alarm() { await this.driver.alarm(); }
```

`OperationProvider` exposes only `submit(submission, signal)`. Return `accepted {jobId}`, `completed {jobId,outcome}`, or a definitive `rejected {error}`; throw for unknown/transient outcomes. Acceptance means the provider stack durably owns execution and completion delivery; that durability may live in the gateway rather than another Worker database. The stateless LLM and bash adapters rely on finite gateway webhook retries, so exhausted delivery needs operator redelivery and can leave a session waiting. Propagate abort signals where supported. Return promptly after acceptance, not after the harness processes the result.

The driver requires a configured adapter for every declared provider, and rejects undeclared provider/type/version combinations before any call. Adapters determine destination/authentication; harness requests contain neither URLs nor credentials.

Production Worker adapters use structured submit RPC and unwrap `{ result: ProviderSubmitResult }` with `parseProviderSubmitReply`. The envelope isolates Cloudflare's outer-object disposal metadata from strict JSON validation; the helper disposes the reply. The stateless operation-worker bindings expose only submission; diagnostic `get` RPCs are removed.

## API

| Driver method | Meaning |
|---|---|
| `initialize` | Local config/harness initialization only, no alarm/kick/status/operation. |
| `appendInput`, `acceptCompletion` | Pre-arm pending work, commit admission, start/join background processing, return durable receipt. Already-consumed duplicate completions return immediately without alarm work or a processing kick. |
| `run`, `alarm` | One bounded, single-flight processing slice. |
| `resumeProcessing` | Explicitly reset the blocked/failed head's retry state and retry it; never skip it. |
| `getSession` | Detached session metadata/config. |
| `getPendingOperations` | Small currently pending acceptance receipts, not operation history. |
| `getProcessingStatus` | Head event ID, attempts, retry deadline, last error and blocked flag. |

The synchronous `SessionRuntime` exposes initialization/admission/reads plus `prepareNext()` and `commit(prepared, receipts)`. Its `prepareCompletion(value)` snapshots, validates and hashes once before async admission. The returned check closure performs one dedup lookup and correlation checks, then supplies a commit closure; callers must keep check/commit and any alarm await inside the same serialized admission scope. Normal hosts should use `SessionDriver.acceptCompletion`, which enforces that scope. It does not dispatch or schedule alarms. A prepared plan must belong to that runtime; receipts must cover every planned operation exactly once. `processNext` and `getOperation` are removed.

Initialization stores only resolved defaults and checks identity on retry. The API's creation hash gate owns content conflicts. Fixed runtime/harness tables bootstrap once; no in-place upgrades. All hooks are synchronous and invocation-scoped. See [harness API](../harness-api/README.md) for deterministic planning requirements.

## Alarms and limits

New inputs/completions establish an alarm **before** durable admission; alarm failure cannot acknowledge unprotected work. Admission-triggered slices reuse that protection without checking the alarm a second time; an explicit `run()` or fired `alarm()` establishes it itself. A matching consumed completion only reads its retained inbox hash and returns its receipt—no alarm or empty processing slice. Matching unconsumed completions still arm recovery and kick processing. A per-instance queue serializes alarm operations, admission, planning and local commit, but never network submission. Final alarm decisions use the pending inbox head only, avoiding a race between admission and idle alarm deletion.

The driver kicks processing before returning admission, but the receipt does not promise that a handler ran or committed. `waitUntil` is not durable recovery. No alarm is scheduled during initialization or solely because accepted jobs exist.

| Policy | Default |
|---|---:|
| maxSteps / maxSliceMs (checked between transitions) | 32 / 250 ms |
| providerTimeoutMs | 10,000 ms |
| submissionConcurrency | 8 |
| recoveryMs / continuationMs | 30,000 / 1 ms |
| retryBaseMs / retryMaxMs | 500 / 60,000 ms |
| maxHandlerFailures | 5 |

Transport ambiguity keeps retrying the same head with bounded exponential backoff/jitter; it never becomes a fabricated rejection. Repeated preparation/apply failures block the head. Later admissions remain available, but handlers cannot overtake it. Blocked heads clear their alarm until explicitly resumed. Status remains harness-owned, not inferred from processing errors.

Budgets do not preempt synchronous work or a whole submission batch. Timeouts do not prove non-acceptance, and RPC cannot necessarily be cancelled. Known late results cannot commit independently of the active processor. No hard cancellation, compaction, streaming or session-wide quota is implemented.

## Completion-admission work

For a warm session with a committed pending operation, new completion admission uses four SQL statements: one inbox dedup read, one pending-operation read, one sequence lookup and one inbox insert. Only the insert writes rows. A consumed duplicate uses one read, including after restart once session metadata is loaded. Cold bootstrap/session reads and early-callback plan reconstruction are additional work. Hash/conflict checks and durable recovery are retained.

Inbox admission and harness processing remain **separate stages/transactions**. The callback is acknowledged after admission; it does not wait for harness handling or downstream operation acceptance.

## Validation

`pnpm --filter @managed-agents/session-runtime check` covers real SQLite and workerd: multi-operation/mixed batches, partial acceptance, warm/cold replay, stable IDs, read-only planning, atomic apply/cleanup, early callbacks, duplicate/conflicting completions, maximum-size inline results, 8 MiB in-memory requests, alarms, poisoning/resume and process restart. App tests add actual Worker RPC and complete minimal-bash loops with deterministic fake upstreams.
