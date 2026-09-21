# Pi harness without compaction

`pi-no-compaction/v1` is a persistent coding agent with a fixed Pi-style prompt and
four tools: `read`, `bash`, `edit`, and `write`. It supports OpenAI Responses and
Fireworks Chat Completions through the existing LLM worker. The package performs
no network or machine filesystem access; its [Worker host](../../apps/harness-pi-no-compaction/README.md)
connects it to the operation workers and transactional session runtime.

## Configuration

```ts
type Config = {
  provider: "openai" | "fireworks";
  modelId: string; // Must belong to the selected provider's allowlist below.
  accountId: string; // LLM gateway account UUID for that provider.
  reasoning?: "low" | "medium" | "high" | "xhigh" | "max"; // Both default to medium.
  maxOutputTokens?: number; // OpenAI: 128000; Fireworks: 32768.
  machineId: string; // Execution gateway machine UUID.
  executionToken: string; // Required me1 machine secret; must match machineId.
  cwd: string; // Absolute machine path.
};
```

Resolved configuration is immutable. Reject unknown fields, invalid UUIDs, relative
paths, unsupported models, null defaults, and output budgets outside the catalog.
OpenAI allows `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
Fireworks allows `accounts/fireworks/models/glm-5p3-flash`,
`accounts/fireworks/models/kimi-k3`, and `accounts/fireworks/models/deepseek-v4p1-flash`.
GLM 5.3 is excluded because it does not support image input. Catalog limits are an
explicit snapshot of `../llm-providers`; there are no cross-repository runtime imports.

The same five reasoning names are accepted for both providers. OpenAI receives
`reasoning: { effort, summary: "auto" }`; Fireworks receives `reasoning_effort: effort`.
Values are passed unchanged: a provider may map several names to the same native tier.
Local checks use
simulated upstreams and do not establish model quality or availability.

The execution token is stored in the initial immutable configuration and used by
the host for discovery and private tool RPC only. It is omitted from host session
responses, model requests and transcripts. There is no token-update API: after
gateway rotation, use a new session with the replacement token. Already accepted
work retains its callback delivery authorization.

Every tool receives the configured machine/cwd. They are not model arguments.
Shell state does not persist between bash calls. Paths follow the existing tool
workers' normal path semantics; cwd is not a security sandbox.

## Prompt and provider requests

[instructions.ts](src/instructions.ts) follows the default preamble, tool snippets,
read/edit/write guidelines, and cwd from the local Pi coding-agent reference. It
also explains independent shells and concurrent calls. No automatic project or
AGENTS.md discovery, extensions, skills, prompt overrides, PI environment injection,
compaction, model switching, or follow-up queue exists.

Each request carries `instructions`, all four existing tool declarations, the full
eligible transcript, and `previousJobId: null`. The prompt is determined by the
versioned harness and immutable config; no duplicate system row is inserted.

OpenAI options:

- `store: false`, `reasoning: { effort, summary: "auto" }`
- `include: ["reasoning.encrypted_content"]`
- session-scoped `prompt_cache_key`, `max_output_tokens`
- `tool_choice: "auto"`, `parallel_tool_calls: true`

Fireworks options:

- `reasoning_effort`, `max_tokens`, session-scoped `prompt_cache_key`
- `tool_choice: "auto"`, `parallel_tool_calls: true`
- `context_length_exceeded_behavior: "error"`

No temperature, service tier, prompt eviction, or reasoning-history override is
sent. The Fireworks adapter owns `stream: false`/`n: 1`. Context plus the requested
output budget must fit the provider limit; no local token estimation or automatic
budget reduction occurs.

## Parallel batches and ordered mutations

A model turn contains one LLM response and all its tool calls. The harness can
submit every read and bash call concurrently, together with the first valid
edit/write. There is **one ordered lane for all edit/write calls within a session**:
only after the previous mutation settles can the next mutation be submitted.

This deliberately serializes even mutations whose path strings differ. Paths can
alias via symlinks, hard links, case folding or filesystem-specific normalization;
the harness has no canonical-file resolver. The daemon mutation lock provides
mutual exclusion but gateway arrival order does not guarantee model order. Waiting
for the prior result preserves that order across worker/gateway boundaries without
extra machine operations. Concurrent mutations to independently resolved files
would require a stronger gateway identity/scheduling contract.

Reads and bash may overlap mutations, as in Pi's parallel tool mode. Arbitrary bash
side effects cannot be inferred; dependent reads or commands belong in a subsequent
model turn. This does not order operations from other sessions or external actors.

Results are durably buffered when they arrive out of order. A contiguous completed
prefix is appended to the transcript in the original call order. The next LLM
request waits for the **entire batch**. Results preserve text, image URLs, and tool
`details`; provider adapters currently send tool content, not diagnostic details,
to the model. The existing image transport is unchanged.

## Inputs, steering, cancellation

Send these events in the API's `{ eventId, event }` envelope:

```ts
{ type: "pi_no_compaction.message", payload: { message: { role: "user", content: [
  { type: "text", text: "Inspect the repository" }
] } } }
{ type: "pi_no_compaction.cancel", payload: { runId: "run_1" } }
{ type: "pi_no_compaction.resume", payload: {} }
```

User text/images and metadata are retained. Idle input starts a run. While active,
messages enter the pending table. **All queued steering**, in admission order, is
promoted after the whole model/tool turn, including a text-only response. This
continues the run. Compared with the current Pi checkout, this changes the default
one-at-a-time steering policy to all-at-once.

Cancellation is run-scoped and soft: complete the current LLM response and all its
tools (including queued mutations), then stop before the next LLM request. It does
not cancel an upstream job. Cancelled/failed sessions hold new messages until an
explicit resume. Stale cancels and resume during an active run are no-ops.

Expected tool errors (file missing, oversized file, rejected/partial edit, command
exit failure) become model-visible error results; the loop continues. Partial edits
retain the worker's warning and receipt. Invalid arguments become nonexecuted tool
errors. Malformed native calls, wrong-provider/model responses, incomplete LLM
responses, or unknown execution outcomes fail the run. Incomplete assistant messages
remain visible outside future context; malformed response envelopes are not stored.

On a terminal operation failure or malformed result, queued tools are skipped with
explicit results. **Already submitted siblings must settle before the run becomes
failed or can resume.** Their real outcomes remain in the ordered transcript. The
first observed failure is retained while the batch drains. No uncertain mutation is
automatically rerun as a fresh job. Inspect the machine before explicit resume.

## Storage and recovery

| Table | Contents |
|---|---|
| `pi_no_compaction_state` | Phase (`idle`, `llm`, `tools`, `cancelled`, `failed`), run ID, LLM operation, assistant row, result-flush cursor, turn count, cancel flag, error. |
| `pi_no_compaction_messages` | Append-only full messages, context flag, correlations, and separate response metadata. |
| `pi_no_compaction_pending_messages` | Steering/held inputs in admission order. |
| `pi_no_compaction_batch` | Call index, queued/active/done status, operation ID, and any completed result awaiting its transcript position. Deleted when the batch finishes. |

Call arguments are reconstructed from the preserved assistant row; no additional
outgoing request copy is stored. OpenAI native reasoning/encrypted items and the
entire Fireworks native message (including reasoning/tool calls and unfamiliar
fields) are replayed unchanged. The harness parses a separate dispatch view.

`handle` returns a deterministic in-memory change plan. SessionDriver submits
operations using stable IDs, then atomically commits changes, acceptance receipts,
and inbox consumption. Early/duplicate callbacks and replay after acceptance-before-
commit use the existing runtime and worker idempotency mechanisms. The batch table
is harness state; it is not a second operation outbox or historical outcome ledger.

D1 status is best-effort display state. The DO state is authoritative. No streaming,
provider polling, status-repair cron, chunk storage, or new runtime schema is added.
Message and pending views support the existing pagination contract (100 rows and
2 MiB of message JSON per page).

## Bounds

- HTTP API input: 64 KiB JSON. Direct harness inputs: 1,800,000 bytes, checked before admission.
- Operation inputs: 8 MiB serialized JSON. Full history beyond this fails explicitly.
- Outcomes/individual message rows: 1,900,000 bytes. Oversized tool-message envelopes
  become small terminal errors, drain active siblings, and fail the run.
- Existing file tools: 5 MiB. The edit worker additionally enforces its 4 MiB native
  request and 256-replacement limits. Assistant-message limits can be reached before
  the write worker's file limit.
- No automatic compaction, history eviction, maximum run turns, or session retention.
- Bash has no default timeout. A stalled job can hold its batch and steering.

## Checks

```sh
pnpm --filter @managed-agents/harness-pi-no-compaction check
pnpm --filter @managed-agents/app-harness-pi-no-compaction check
```

Tests cover both provider shapes/options, mixed parallel batches, ordered mutations,
out-of-order results, image replay, all-at-once steering, cancellation/resume,
restart, early callbacks/replay/deduplication, malformed responses, expected tool
errors, fatal sibling drainage, and payload limits. Host tests use real Worker RPC,
SQLite DOs and D1. The complete worker-stack test additionally uses production
LLM/tool/callback code with machine-secret gateway fixtures and a simulated image upload service.
Native integration tests additionally use the real execution gateway and an isolated daemon.
