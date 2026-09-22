# Codex-style apply_patch worker

Standalone, stateless `tool-codex-apply-patch/apply_patch/v1` provider. Each call
submits one native `filesystem.patch` request using `format: "codex"` through the
machine-only execution gateway. See the [earlier deployment record](../../../execution/DEPLOYMENT.md); the per-session gateway URL contract requires a coordinated rollout.
Its production session routes remain empty until a harness adopts apply_patch.
Neither production harness currently exposes this tool.

## Input and model interface

`CODEX_APPLY_PATCH_TOOL` is a custom freeform tool named `apply_patch`, using the
single-environment Lark grammar from OpenAI Codex. The model passes raw text:

```text
*** Begin Patch
*** Add File: nested/config.ts
+export const enabled = true;
*** Update File: old.ts
*** Move to: new.ts
@@
-old();
+updated();
*** Delete File: obsolete.ts
*** End Patch
```

The immutable operation input is `{ machineId, cwd, patch }`. The consuming harness
supplies the trusted machine UUID and absolute cwd, and passes the model's raw
custom-tool input as `patch`. Extra input fields are rejected. Patch text is not
trimmed, parsed, repaired, or split by the worker; syntax failures become native
model-visible errors. Paths resolve on the machine, including absolute paths.
There is no worker shell execution, preliminary file read, or read/write fallback.

Our shared LLM contract and OpenAI/ChatGPT adapters support custom grammar tools.
The current Fireworks adapter rejects them. A future Fireworks harness would need
a function wrapper such as `{ patch: string }` feeding the same worker. A consuming
OpenAI harness must handle `custom_tool_call.input`, retain native assistant items,
and supply the tool definition when sending results so the LLM provider emits
`custom_tool_call_output`. No existing harness is changed by this package.

The private harness-to-worker RPC is:

```ts
{
  destination: { routeKey, sessionId },
  execution: { gatewayUrl, token, runtimeGeneration },
  submission: {
    operationId, submissionId,
    request: {
      provider: "tool-codex-apply-patch", type: "apply_patch", version: "v1",
      input: { machineId, cwd, patch }
    }
  }
}
```

The harness supplies the machine's `me1` execution secret and pinned runtime
generation outside model arguments. The worker validates shape and machine binding;
the gateway authenticates the hash/version. Each RPC forwards its own token only in
the Authorization header. The worker never stores, discovers, or rotates tokens.
There are no user credentials, temporary grants, API keys, or legacy input fallbacks.

## Results

Success follows Codex's A/M/D summary style, with resolved paths. Moves appear as
`M` at the destination. Adds, modifications, and deletions are grouped; structured
change records retain native commit order, including repeated paths.

```ts
{
  content: [{ type: "text", text: "Success. Updated the following files:\nA /workspace/config.ts\n" }],
  isError: false,
  details: {
    requestId, machineId, mutationId,
    status: "applied", changesExact: true,
    changes: [{ kind: "add", path: "/workspace/config.ts",
      beforeSha256: null, afterSha256, bytesBefore: null, bytesAfter,
      firstChangedLine: 1 }],
    diff, diffTruncated, summaryTruncated: false
  }
}
```

The native core's bounded unified display diff is metadata, not a guaranteed reusable
patch. Move records retain destination paths and overwritten-destination hashes
and sizes. Missing file sides are null; newly created move destinations normalize
omitted native destination-before metadata to null. Summary text is limited to
16 KiB plus a truncation marker; filenames' control characters are escaped. Full
structured changes are retained.

| Native receipt / outcome | Provider result |
| --- | --- |
| applied / ok | Completed tool result, `isError: false` |
| rejected / ok | Completed tool result, `isError: true`; requested file changes were not applied |
| partial / ok | Completed tool result, `isError: true`; known changes and `changesExact` retained |
| uncertain error | Failed operation, `APPLY_PATCH_OUTCOME_UNKNOWN`; files may have changed |

Partial results tell the model to inspect affected files before another patch.
The worker never automatically submits a new mutation for partial or unknown
outcomes. Outer protocol `invalid_argument` and `resource_limit` errors are
pre-execution tool errors. Other infrastructure, protocol, and idempotency errors
remain failed operations. Contradictory or malformed receipts fail callback
admission, allowing delivery retry instead of inventing success.

## Native semantics and limits

Uses the current core operation `filesystem.patch`; the daemon derives the native
mutation ID from the gateway request ID. No separate `mutation_id` parameter or
legacy v5 response wrapper is sent.
The daemon supports add/update/delete/move-with-update, repeated file sections,
multiple ordered hunks, context anchors, EOF markers, and exact/whitespace/Unicode
punctuation matching. Adds and moves can overwrite existing destinations.

The daemon plans the entire patch before committing and rechecks file preconditions.
This is not a multi-file atomic transaction: commit failures may leave changes.
Each content write uses staged atomic replacement, preserves permissions, and
shares the runtime's file-mutation synchronization. Parent directories created
for adds/moves may remain after failure. External processes can still race writes.

- Patch text: **2 MiB UTF-8**.
- Serialized native parameters: **4 MiB**, including JSON escaping.
- Each original/resulting file: **5 MiB** (or a lower daemon limit).
- **32 sections**, **256 hunks/edits**, **20 MiB** aggregate planning bytes.
- Paths: **4096 bytes**; native matching work is bounded.
- Display diff: **64 KiB**, omitted for sections above **256 KiB** before-plus-after.
- Native receipts: **1,700,000 serialized bytes**, dropping optional diff if needed.

The worker checks text and serialized-parameter budgets before POST. Oversized
requests that fit the generic 8 MiB submission transport complete locally with
`APPLY_PATCH_REQUEST_TOO_LARGE` and a stable `local:codex-apply-patch-v1:<hash>`
receipt. These results have no gateway request and no filesystem effect. Session
storage limits may impose smaller practical inputs in a consuming harness.

Intentional differences from the local Codex reference: native historical line
reconstruction can retain CR bytes in unchanged lines and adds final LF; optional modern line-ending
preservation is not exposed. Embedded environment/workdir routing is rejected.
Content updates follow final symlinks; delete/move sources reject final symlinks;
symlink aliases within a patch are rejected. Hard-link aliases are not tracked.
Exact diagnostics and display diff rendering follow the native core. Only raw
patch text is supported, not the CLI's lenient heredoc wrapper. Preflight validation
of all files prevents earlier writes when a later section is invalid; Codex's CLI
can commit those earlier sections. These are not byte-for-byte identical tools.

## Replay and callback architecture

`CodexApplyPatch.submit` is private RPC returning `{ result }`.
It POSTs only to `/v1/machines/:machineId/requests`:

```ts
{
  requestId, runtimeGeneration,
  operation: { operation: "filesystem.patch", params: { cwd, patch: { format: "codex", text } } },
  callback: { receiver: "tool-codex-apply-patch-v1", context }
}
```

A validated 202 maps to `{ status: "accepted", jobId: requestId }` in the generic
provider contract. Request IDs are `codex-apply-patch-v1:<SHA256(submissionId)>`.
The request fingerprint and mutation ID do not change when the execution secret
rotates. Context contains route/session/operation/submission IDs, machine, runtime,
cwd, and patch SHA-256—not patch text or credentials.

`CodexApplyPatchCallbacks.acceptExecutionResult` accepts only the new private
gateway completion event and returns the receipt directly (no `{ receipt }`
wrapper). It checks correlation, result/delivery hashes and native mutation receipt,
then invokes the Session DO's `acceptToolCompletion` with the execution pin.
Acknowledgement requires the session's durable admission receipt. Public HTTP
exposes only `GET /health`; there is no webhook.

The daemon's durable outbox retries delivery. Repeated submissions use the same
identity and re-deliver the retained result; the worker never polls job details or
re-runs a mutation to recover a result. Accepted work may finish despite a lost HTTP
response or deadline. Malformed acceptance/errors, revoked authorization,
runtime changes, and conflicts remain uncertain/retryable at the provider boundary;
they never authorize a fresh patch ID. Known definitive submission rejections remain
rejections. Uncertain native mutation outcomes become failed operations.

Worker submission budget: seven seconds; callback admission: six seconds.
Logs contain correlation/status only, never tokens, patch text or diffs.
There is no worker database, Durable Object ownership, Queue, or cron.

## Deployment and adoption

App-owned gateways must implement the [tool-facing contract](../GATEWAY-CONTRACT.md),
including the private callback binding; the gateway URL alone does not configure delivery.

1. Deploy this worker at `managed-agents-tool-codex-apply-patch`.
   The harness supplies `execution.gatewayUrl`; no deployment-wide URL or static execution credential is required.
2. The gateway's checked-in private binding routes
   `tool-codex-apply-patch-v1 → APPLY_PATCH_EVENTS → CodexApplyPatchCallbacks`.
   There is no separate callback router.
3. A consuming harness must provide `execution`, admit `acceptToolCompletion`
   against its runtime pin, and configure matching `SESSION_ROUTES`/namespace
   bindings on this worker. It deliberately starts with no production session routes.
4. Schedule filesystem mutations in order where they can overlap.

No model tool has been added to either existing harness in this change.

## Verification

```sh
pnpm --filter @managed-agents/contracts check
pnpm --filter @managed-agents/tool-codex-apply-patch-workers check
```

Tests cover private RPC, strict new input/callback contracts, concurrent credentials,
rotation, lost acceptance, early and duplicate delivery, Session DO restart,
admission failures, partial/unknown outcomes, malformed receipts, and size budgets.
The native integration builds and starts an isolated daemon with the real Machine
DO/gateway, worker and Session DO; it does not touch the installed daemon.

The suite includes 22 vendored Codex filesystem scenarios through the full stack,
plus native multi-file/move/fuzzy matching, symlink, preflight, size and replay checks.
Excluded reference scenarios are documented in `test/codex-scenarios.ts`: partial
preflight behavior and opt-in line-ending preservation intentionally differ.
Native commit-failure tests live in process-execution-core.

References:

- Native parser: [patch.rs](../../../execution/packages/process-execution-core/src/native/filesystem/patch.rs).
- Grammar/fixture license: [Codex license](../../../packages/contracts/third-party/codex/LICENSE).
