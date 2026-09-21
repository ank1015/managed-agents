# Codex-style apply_patch worker

Standalone, stateless `tool-codex-apply-patch/apply_patch/v1` provider. Each call
submits one native `filesystem.apply_patch` job using `format: "codex"`.
Deployed and verified on this Mac on 2026-09-21: 27 checks across 23 live gateway jobs.
No production harness includes the tool.

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

The private worker input is `{ machineId, cwd, patch }`. The consuming harness
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

## Results

Success follows Codex's A/M/D summary style, with resolved paths. Moves appear as
`M` at the destination. Adds, modifications, and deletions are grouped; structured
change records retain native commit order, including repeated paths.

```ts
{
  content: [{ type: "text", text: "Success. Updated the following files:\nA /workspace/config.ts\n" }],
  isError: false,
  details: {
    gatewayJobId, machineId, mutationId,
    status: "applied", changesExact: true,
    changes: [{ kind: "add", path: "/workspace/config.ts",
      beforeSha256: null, afterSha256, bytesBefore: null, bytesAfter,
      firstChangedLine: 1 }],
    diff, diffTruncated, summaryTruncated: false
  }
}
```

The gateway's bounded unified display diff is metadata, not a guaranteed reusable
patch. Move records retain destination paths and overwritten-destination hashes
and sizes. Missing file sides are null; newly created move destinations normalize
omitted native destination-before metadata to null. Summary text is limited to
16 KiB plus a truncation marker; filenames' control characters are escaped. Full
structured changes are retained.

| Native receipt / gateway state | Provider result |
| --- | --- |
| applied / succeeded | Completed tool result, `isError: false` |
| rejected / failed | Completed tool result, `isError: true`; requested file changes were not applied |
| partial / failed | Completed tool result, `isError: true`; known changes and `changesExact` retained |
| unknown | Failed operation, `APPLY_PATCH_OUTCOME_UNKNOWN`; files may have changed |

Partial results tell the model to inspect affected files before another patch.
The worker never automatically submits a new mutation for partial or unknown
outcomes. Outer protocol `invalid_argument` and `resource_limit` errors are
pre-execution tool errors. Other infrastructure, protocol, and idempotency errors
remain failed operations. Contradictory or malformed receipts fail callback
admission, allowing delivery retry instead of inventing success.

## Native semantics and limits

Requires execution protocol v5 and native `apply_patch_formats` containing `codex`.
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
receipt. These results have no gateway job and no filesystem effect. Session
storage limits may impose smaller practical inputs in a consuming harness.

Differences from current Codex: native historical line reconstruction can retain
CR bytes in unchanged lines and adds final LF; optional modern line-ending
preservation is not exposed. Embedded environment/workdir routing is rejected.
Content updates follow final symlinks; delete/move sources reject final symlinks;
symlink aliases within a patch are rejected. Hard-link aliases are not tracked.
Exact diagnostics and display diff rendering follow the gateway.

## Replay and callback architecture

`CodexApplyPatch.submit` is private RPC returning `{ result }`.
`CodexApplyPatchCallbacks.acceptGatewayEvent` is callback-only RPC returning
`{ receipt }`. Only the trusted HMAC-verifying router should bind the latter.
Public HTTP exposes only `GET /health`.

Gateway idempotency and runtime mutation IDs are
`codex-apply-patch-v1:<SHA256(submissionId)>`. Signed clientContext includes receiver,
route/session/operation/submission IDs, machine, cwd, and patch SHA-256; it excludes
patch text and credentials. Receipt validation checks the v5 response correlation,
runtime generation, mutation identity, status, and all change variants.

Callbacks use the inline response and never query or mutate the filesystem.
Acknowledgement requires the session's durable completion receipt. Terminal
submission replay retrieves gateway job detail and runs the same normalizer.
Early callbacks, lost acceptance, duplicate delivery, and lost admission receipts
use the existing gateway/session replay paths. Native receipts are memory-resident
within one runtime generation; they do not survive daemon restart. Deadlines do
not undo accepted mutations. Worker deadline: eight seconds; gateway HTTP: seven.
Logs contain correlation/status only, never patch contents or diffs.

## Deployment and adoption

1. Deploy `managed-agents-tool-codex-apply-patch` with a dedicated
   `EXECUTION_GATEWAY_API_KEY` for a user configured for the existing v3 callback URL.
2. Deploy the callback router after the worker exists. Its staged route is
   `tool-codex-apply-patch-v1 → APPLY_PATCH_EVENTS → CodexApplyPatchCallbacks`.
3. When adding a consuming harness, configure this worker's `SESSION_ROUTES` and
   matching DO namespace binding together, then bind the harness to `CodexApplyPatch`.
   The checked-in worker deliberately starts with no session routes or DO bindings.
4. Schedule filesystem mutations in order where they can overlap; one patch is
   already one native operation. No execution gateway or daemon changes are needed.

There is no worker database, Durable Object ownership, Queue, or cron.

## Verification

```sh
pnpm --filter @managed-agents/contracts check
pnpm --filter @managed-agents/tool-codex-apply-patch-workers check
pnpm --filter @managed-agents/execution-gateway-callback-workers check

PROCESS_EXECUTION_TEST_BINARY=/absolute/path/to/process-execution \
  pnpm --filter @managed-agents/tool-codex-apply-patch-workers test
```

The workerd tests use the real private RPC worker, signed callback router, SQLite
session DO, and SessionDriver with a fake gateway. The optional native integration
starts an isolated runtime in temporary files, executes actual v5 patches, and feeds
native responses through the same worker/router/session path. It does not touch the
connected daemon. Coverage includes multi-file changes, matching, preflight errors,
file limits, symlinks, mutation replay, callback recovery, partial receipts, malformed
correlation/metadata, and request/result budgets. Native partial commit failures are
covered in execution-providers; worker partial receipts are fault-injected here.

References:
- Codex: `/Users/notacoder/Desktop/harnesses/codex/codex-rs/apply-patch` and
  `codex-rs/core/src/tools/handlers/apply_patch_spec.rs`.
- Native gateway runtime: `../execution-providers/packages/process-execution-core/src/filesystem/patch.rs`.
- Grammar license/attribution: `packages/contracts/third-party/codex/`.
