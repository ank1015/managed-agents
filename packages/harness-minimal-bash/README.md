# Minimal bash harness

`minimal-bash/v1` is a persistent coding agent with a fixed system prompt, OpenAI, and exactly one tool: Pi-style `bash`. Its [Worker host](../../apps/harness-minimal-bash/README.md) connects the transactional harness to the existing operation workers. This package performs no network calls.

## Terminology and configuration

- **Model turn:** one LLM response and all tool calls in that response.
- **Run:** the sequence of model turns answering a user request, including steering received during that work.
- **Session:** the persistent conversation containing many runs.

```ts
type Config = {
  provider: "openai";
  modelId: "gpt-6-astra" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
  accountId: string; // UUID owned by the LLM worker's dedicated gateway user
  reasoning?: "low" | "medium" | "high" | "xhigh" | "max"; // default: medium
  machineId: string; // UUID accessible to the execution-gateway user
  cwd: string; // absolute path on that machine
};
```

Config is immutable after initialization. Unknown fields, unsupported models/providers, malformed UUIDs and relative paths are rejected. The model catalog is an explicit snapshot of `../llm-providers/packages/provider-openai/src/models.ts`; updates require a deliberate local capability update. All five reasoning levels are supported by the four allowlisted models as verified against their official OpenAI model pages on 2026-09-18. The default is our harness policy, not the provider's default.

Each bash invocation receives the same configured machine and cwd. A preceding `cd` or `export` does not change the next invocation. The model supplies only the Pi tool's `command` and optional `timeout` in seconds. Neither cwd nor the system prompt is a security sandbox.

## Inputs

Send these event bodies inside the API's `{ eventId, event }` envelope:

```ts
type Input =
  | { type: "minimal_bash.message"; payload: { message: UserMessage } }
  | { type: "minimal_bash.cancel"; payload: { runId: string } }
  | { type: "minimal_bash.resume"; payload: {} };
```

`UserMessage` is the gateway-compatible `role: "user"` member of `LlmMessage` from `packages/contracts`. Text, image content and optional metadata are preserved. Inputs cannot fabricate assistant/system/tool/custom messages. Event IDs deduplicate admission; changed content under the same ID conflicts. A 202 acknowledges durable admission, not processing.

When idle, a message starts a run. While the model or tools are active, every message is steering: it is retained in the pending table. At the end of the **entire** model turn, all pending messages are appended to history in admission order and included together in the next request. This also applies to a final text response when steering was already queued. There is no follow-up mode; app-side follow-ups must be sent when desired.

Cancellation is run-scoped so a delayed cancel cannot stop a later run. It sets `cancelling`, finishes the current LLM response and **every** bash call in that response, then becomes `cancelled` without another LLM request. It does not kill a command or cancel a gateway job. Pending messages remain held, including messages admitted after cancellation or failure. Explicit `minimal_bash.resume` starts a new run, drains held messages and continues from history. Resume while idle/running and cancellation for a noncurrent run are no-ops. Harness resume does not unblock a runtime infrastructure/poison-event failure.

## Persistence and transitions

All harness writes and operation requests occur inside the runtime's single-event SQLite transaction.

| Table | Contents |
|---|---|
| `minimal_bash_messages` | Ordered full message JSON, context inclusion flag, run/event/operation correlation, separate response metadata (usage, stop reason, gateway job ID, etc.). |
| `minimal_bash_pending_messages` | Acknowledged messages not yet in transcript, keyed by event ID and ordered by runtime input sequence. |
| `minimal_bash_state` | Phase, run ID, active operation ID, active assistant row, next tool index, turn count, cancel flag and last failure. |
| `minimal_bash_json_chunks` | Chunk rows backing large transcript messages, response metadata and pending messages. Owning fields contain either inline JSON or a small manifest. |

The runtime already owns inbox ordering, operations, temporary request outbox, retries, outcomes and alarms. The harness does **not** duplicate those ledgers. Its assistant-row/tool-index cursor answers a different question: which call in the preserved response should run next after a restart?

`idle → llm → bash → … → llm → idle` is the normal path; bash steps are serial. A text-only response finishes its model turn immediately. A tools response requests another model turn after all results and steering enter history. The allowlist contains only `llm/generate/v1` and `tool-pi-bash/bash/v1`.

`run_started`, `cancel_requested`, `run_cancelled`, `run_resumed`, `run_failed` and `run_finished` are custom **messages in the same transcript table**, not another events table. Their `inContext` flag is false. No output-event contract or `runtime_outputs` table has been added.

The host separately stores a tiny `minimal_bash_host_status` row for D1 projection revisions. Public status is `running` for internal `llm`/`bash`, `cancelling` when a stop is pending, otherwise `idle`/`cancelled`/`failed`. The shared `waiting` enum is unused here. D1 is a listing projection, not the state-machine authority.

## Context and result handling

Every request contains the full context-eligible transcript and `previousJobId: null`. Valid assistant messages, including native reasoning, encrypted replay content and tool-call items, are stored and resent unchanged. User/system/tool-result messages use the gateway contract directly. The gateway's provider adapter performs provider conversion; no text-only reconstruction happens here.

OpenAI options are `store: false`, configured `reasoning.effort`, `reasoning.summary: "auto"`, `include: ["reasoning.encrypted_content"]`, session-scoped `prompt_cache_key`, `max_output_tokens` set to the catalog model's output limit, `tool_choice: "auto"` and `parallel_tool_calls: false`. No temperature or service tier is sent. There is no local token/context estimate: within the transport payload limit, full history is sent and the provider decides whether it fits. A terminal provider context-overflow error follows the normal LLM failure path and marks the run failed. There is no automatic compaction or retry with trimmed history.

Complete native responses are retained. Truncated, content-filtered, paused, wrong-model or unsupported-tool responses fail the run and stay outside future context, avoiding replay of an incomplete call sequence. Structurally malformed gateway results remain in the runtime outcome ledger. Invalid bash arguments become nonexecuted tool errors. Known command failures/timeouts become model-visible tool errors and the loop continues.

Unknown/failed bash operation outcomes stop the run and fill remaining unexecuted calls with error results, preserving a coherent call sequence. Transient delivery failures stay in worker/runtime recovery rather than inventing terminal outcomes. Neither the harness nor reconciliation automatically reruns an uncertain command. Inspect the machine before resuming; the model can choose another command after explicit resume.

Expected limits/provider failures commit a failed state and custom message instead of poisoning the inbox. Unexpected SQL/invariant failures roll back and use the runtime's retry/block policy.

## Bounds and remaining work

- API inputs: unchanged at 64 KiB JSON. Operation inputs/outcomes: 8 MiB UTF-8 JSON, separately. Large values use transactional [chunked SQLite storage](../sqlite-json/README.md), including runtime completion events and native assistant messages. Full-history requests beyond 8 MiB fail with `OPERATION_INPUT_TOO_LARGE`, distinct from a provider context error. No compaction, R2 references or gateway continuation exists.
- No harness-imposed limit on model turns per run or bash calls per response. Our payload bounds and provider-enforced context limits still apply.
- Transcript/pending reads: at most 100 rows and a 2 MiB target for reconstructed message/metadata JSON per page. One larger message is returned alone, intact, so an individual page can exceed that target. Pagination uses manifest byte counts before loading large bodies. Pending entries disappear when promoted; that view is not an immutable feed.
- Pending queues, transcript, consumed inputs and completed outcomes have no retention or session-wide quota. No token streaming or push transport.
- Soft cancellation cannot stop a stalled operation. Bash has no default timeout when the model omits one.
- The LLM gateway retains a full request snapshot per job within its retention policy. Runtime outbox cleanup does not fix repeated upstream full-history storage.
- Execution-host log quotas, restart-safe cleanup, timeout grace and log expiry remain upstream constraints; see the [bash worker](../../apps/tool-pi-bash-workers/README.md#upstream-limits-and-pi-differences).

## Checks

```sh
pnpm --filter @managed-agents/harness-minimal-bash check
pnpm --filter @managed-agents/app-harness-minimal-bash check
```

Package tests use the real transactional runtime and SQLite. Host tests add Worker RPC, Durable Objects, D1, Queues and the API. They cover native replay, serial tool batches, steering, cancellation/resume, duplicates, limits, rollback, process restart and directory repair. The full-worker test uses production LLM/bash/callback code with deterministic fake upstream gateways; no paid requests or cloud deployments occur.
