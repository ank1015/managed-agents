# Pi-style edit worker

Stateless `tool-pi-edit/edit/v1` provider using the new execution gateway's
`POST /v1/machines/:machineId/requests` and one native `filesystem.patch` operation. This breaking
migration removes the old jobs API, shared gateway key and HMAC callback protocol.

## Model arguments and results

Pi's current array schema remains:

```ts
{ path: string, edits: Array<{ oldText: string, newText: string }> }
```

The trusted caller adds `machineId` and absolute `cwd`. Relative/absolute paths use
normal filesystem resolution without `~` or `@` expansion. Empty `newText` and
whitespace-only `oldText` are valid; empty `oldText`, extra properties, NUL paths,
legacy top-level oldText/newText and more than 256 replacements are rejected.

Every replacement matches the original file. Matches must be unique and ranges
must not overlap. The native core reads, plans and commits under its mutation
synchronization. No preliminary read, shell invocation or second operation is used.

Success remains `Successfully replaced N block(s) in <path>.` with `isError: false`.
Results preserve bounded unified `diff`/`patch`, `firstChangedLine`, `diffTruncated`,
mutation ID, status, `changesExact` and before/after file metadata.
**`details.requestId` replaces `details.gatewayJobId`.** The worker verifies the
mutation ID, single-file update receipt and consistent status before admission.

Matching is exact after LF normalization, preserving a leading UTF-8 BOM and
restoring the selected newline style. Pi's Unicode/whitespace fuzzy matching and
legacy argument repair are not implemented. Diffs are bounded unified display diffs,
not Pi's numbered renderer. Atomic replacement follows final symlinks; other hard
links retain the old inode. These existing differences from Pi are unchanged.

## DO submission and native request

Private `PiEdit.submit` returns `{ result }` and requires:

```ts
{
  destination: { routeKey, sessionId },
  execution: { token, runtimeGeneration },
  submission: {
    operationId, submissionId,
    request: {
      provider: "tool-pi-edit", type: "edit", version: "v1",
      input: { machineId, cwd, path, edits }
    }
  }
}
```

The caller pins the runtime and supplies that machine's execution secret.
The worker checks the secret's machine identity; the gateway authenticates its
hash and current version. Secrets stay outside model input and history. The
callback receiver is fixed to `tool-pi-edit-v1`; its context carries the session
route, operation identities and input fingerprints. No temporary grant or
account-wide execution credential is involved.

```ts
{
  requestId: "pi-edit-v1:<SHA-256 of submissionId>",
  runtimeGeneration,
  operation: {
    operation: "filesystem.patch",
    params: { cwd, patch: { format: "text_replacements", files: [{ path, edits }] } }
  },
  callback: { receiver: "tool-pi-edit-v1", context: { /* routeKey, sessionId; identities, path/cwd, edit count and edits SHA-256 */ } }
}
```

The core derives mutation ID from request ID; no `mutation_id` parameter is sent.
Callback context contains neither replacement text nor credentials. Pin the runtime,
input and submission identity across retries; compatible secret replacement keeps
the same request hash. Never retarget an uncertain edit to a new runtime.

HTTP 202 confirms acceptance. The generic provider `jobId` carries request ID; there
is no remote job detail lookup. Lost/malformed acceptance retries that identity.

## Return flow and errors

Daemon → Machine DO → `PiEditCallbacks.acceptExecutionResult` → Session DO
`acceptToolCompletion`. Only a matching durable admission receipt permits returning the
new flat receipt `{ status: "accepted", deliveryId, requestId, requestHash, resultHash }`.
Machine acknowledges the daemon afterward. Early callbacks, failed/lost
receipts and duplicate delivery use the daemon journal and Session DO deduplication.

| Native result | Tool/provider result |
| --- | --- |
| Applied receipt | Success, `isError: false`, verified diff/change metadata |
| Rejected receipt | Completed `isError: true`; no changes |
| Partial receipt | Completed `isError: true`, retained known changes and instruction to inspect the file |
| Definite file/argument/resource error | Completed `isError: true` |
| Uncertain error | Failed `EDIT_OUTCOME_UNKNOWN`; inspect before deciding on another edit |

Missing/ambiguous text, overlap, no-change, permission, conflict and file-limit
messages are preserved. Malformed receipts fail delivery and never invent success.
The adapter never creates a replacement mutation after a partial/unknown outcome.
Guarantees are bounded by runtime lifetime and daemon journal retention.

## Limits and configuration

- Native before/after file limit: **5 MiB** under the normal daemon configuration.
- One file, at most 256 replacements.
- **4 MiB serialized parameters**, including escaping. Larger requests within the
  generic transport cap finish locally with `EDIT_REQUEST_TOO_LARGE`, without POST.
- Generic input transport: **8 MiB serialized JSON**. Native matching/patch limits
  also apply and may reject smaller requests.
- Diff: at most **64 KiB**, with explicit truncation/omission metadata.
- Submission deadline: seven seconds; callback admission: six seconds.

Set `EXECUTION_GATEWAY_URL=https://execution-api.acentric.dev`, `SESSION_ROUTES` and
matching session namespace bindings. Machine config routes
`tool-pi-edit-v1 → EDIT_EVENTS → managed-agents-tool-pi-edit#PiEditCallbacks`.
No gateway account secret, adapter D1, DO, Queue or polling is needed. Public HTTP
exposes only GET `/health`. Timeout does not undo an accepted mutation.

Production harness execution-context integration is implemented. Coordinate its
deployment and drain old edits before rollout. Deploy this worker before the
gateway with its matching private callback binding. This contract is deployed; see the [deployment record](../../../execution/DEPLOYMENT.md).

## Verification

`pnpm --filter @managed-agents/tool-pi-edit-workers check` runs typechecks, workerd
private-RPC/SessionDriver/SQLite tests and a dry-run build. Tests cover secret replacement,
identity conflicts, early/duplicate callbacks, lost durable receipts, restart,
structured rejected/partial receipts, malformed receipts and request limits.

The native integration builds the repository's Rust daemon with Cargo and runs the
real local gateway/Machine stack against temporary files. It verifies edits,
batches against original content, BOM/CRLF, ambiguity, symlinks, file limits and
replay of an older edit after a later mutation. It leaves the installed daemon alone.


The harness supplies `execution: { token, runtimeGeneration }` on every submit.
The token must be this machine's `me1.…` execution secret. This worker neither
stores nor discovers, rotates or refreshes it. Different submissions can target
different machines with different tokens; the harness owns that choice.
Credential storage and replacement are outside this tool's contract.

Only the current [execution gateway](../../../execution/apps/execution-gateway/README.md)
is supported. User credentials, temporary grants, daemon secrets, legacy jobs
responses and public webhook envelopes are rejected; there is no compatibility
fallback. Malformed replies after dispatch are uncertain and must be retried with
the same request identity. A replacement secret does not change that identity.
