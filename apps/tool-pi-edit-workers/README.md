# Pi-style edit worker

Standalone stateless `tool-pi-edit/edit/v1` provider. Each call submits one native
`filesystem.apply_patch` job using `text_replacements`. No preliminary file read,
shell command, adapter database, Durable Object, Queue or background delivery is
needed. Production harness adoption is separate; the minimal-bash harness is unchanged.

## Model arguments and results

`PI_EDIT_TOOL` exposes the current local Pi edit schema:

```ts
{ path: string; edits: Array<{ oldText: string; newText: string }> }
```

`EditInput` additionally requires trusted `machineId` and absolute `cwd`. Relative
and absolute paths use normal machine filesystem resolution, without `~` or `@`
expansion. Arguments are strict: no extra fields, legacy top-level oldText/newText,
stringified arrays, empty edits, empty oldText or NUL in paths. Empty newText and
whitespace-only oldText are valid. At most 256 replacements are allowed.

Every edit matches against the original file. Matching text must be unique and
replacement ranges must not overlap. Multiple disjoint replacements can be supplied
in any order, including mid-line and multiline fragments. The runtime reads,
plans and commits the file under its native mutation synchronization.

Success text matches the inspected Pi implementation:

```ts
{
  content: [{ type: "text", text: "Successfully replaced 2 block(s) in file.ts." }],
  isError: false,
  details: {
    diff, patch, firstChangedLine, diffTruncated,
    gatewayJobId, machineId, path, mutationId,
    status: "applied", changesExact: true,
    changes: [{ path: resolvedPath, beforeSha256, afterSha256,
      bytesBefore, bytesAfter, firstChangedLine }]
  }
}
```

`diff` and `patch` both contain the gateway's bounded unified **display** diff.
It is not Pi's numbered display renderer or a guaranteed reusable patch. Line
numbers are one-based. Diffs can be truncated or omitted, indicated by
`diffTruncated`; a successful edit remains successful when a diff is omitted.

### Intentional differences from Pi

The native gateway performs exact LF-normalized replacement matching. It preserves
a leading UTF-8 BOM and restores its selected newline style; it does not provide
Pi's NFKC/Unicode/whitespace fuzzy matching. Mixed endings may be normalized. The
worker uses the current array schema and does not implement Pi's legacy argument
repair. Filesystem writes use the gateway's atomic replacement and precondition
checks, which differ from Pi's direct fs.writeFile behavior. Final symlinks are
followed for edits; other hard links retain the old inode.

Reference source: `/Users/notacoder/Desktop/harnesses/pi/packages/coding-agent/src/core/tools/edit.ts`
and `edit-diff.ts`. Native implementation:
`/Users/notacoder/Desktop/superpowers/execution-providers/packages/process-execution-core/src/filesystem/patch.rs`.

## Errors and uncertainty

The gateway returns a structured patch receipt inside a protocol `status: "ok"`
response. The adapter checks both receipt status and gateway job status:

| Native outcome | Gateway job | Provider outcome |
| --- | --- | --- |
| applied | succeeded | Completed tool result, isError false |
| rejected | failed | Completed tool result, isError true; file unchanged |
| partial | failed | Completed tool result, isError true; file may have changed |
| unknown execution | unknown | Failed operation, EDIT_OUTCOME_UNKNOWN |

Rejection messages such as missing/ambiguous text, overlap, no change, missing
file, permission errors, precondition conflicts and file-size limits are preserved.
Partial results retain known file changes, `changesExact`, and the native error;
the model is told to inspect the file before attempting another edit. The adapter
does not automatically submit another mutation for partial or unknown outcomes.

Outer protocol invalid_argument/resource_limit errors are pre-execution tool errors.
Unstructured I/O, unsupported protocol, idempotency and infrastructure errors remain
failed operations. Invalid or contradictory receipts fail callback admission so the
gateway can retry delivery; they never become invented successes.

## Limits

- File before and after editing: at most **5 MiB**, enforced by the native runtime.
- One file and at most 256 replacements per tool call.
- Serialized native parameters: at most **4 MiB**, including JSON escaping. The
  worker checks the exact submitted parameter shape before POST. Larger requests
  that fit the generic transport budget complete locally with
  `EDIT_REQUEST_TOO_LARGE` and a stable `local:pi-edit-v1:<hash>` receipt ID.
  Such results have no gatewayJobId and cause no gateway request.
- Generic submission transport: **8 MiB serialized JSON**. Larger submissions are
  rejected before execution.
- Native matching work and aggregate byte limits still apply and can reject a call
  below the transport limits. File limits cannot be inferred just from edit size.
- Gateway diff: at most **64 KiB**, omitted for before-plus-after content above
  256 KiB. The adapter's bounded result fits the existing 1,900,000-byte outcome cap.

## Gateway contract and replay

Requires execution protocol **v5**, with `runtime.filesystem.apply_patch_formats`
containing `text_replacements`. No fallback to read/write jobs or shell execution.

```json
{
  "operation": "filesystem.apply_patch",
  "params": {
    "mutation_id": "pi-edit-v1:<SHA256(submissionId)>",
    "cwd": "/workspace/project",
    "patch": {
      "format": "text_replacements",
      "files": [{ "path": "file.ts", "edits": [{ "oldText": "false", "newText": "true" }] }]
    }
  }
}
```

Gateway idempotency key and runtime mutation ID share that stable identity.
Signed clientContext contains receiver `tool-pi-edit-v1`, session destination,
operation/submission identity, machine, cwd, path, replacement count and SHA-256 of
the normalized edits array. It contains no replacement text or credentials. The
runtime owns matching and output hashes; the worker does not know the resulting
file bytes in advance.

`PiEdit.submit` is private RPC returning `{ result }`. `PiEditCallbacks` is a
separate callback-only entrypoint returning `{ receipt }`. Only the trusted HMAC
verifying callback router should bind it. The adapter validates machine, job,
generation, v5 protocol, mutation ID, count, single update receipt and status.
Callback processing never fetches a job or submits an edit.

Acknowledgement requires the configured session namespace's durable admission
receipt. Gateway retries plus session admission deduplication handle early callbacks,
lost acceptance, lost admission receipts and duplicate delivery. Terminal submission
replay retrieves gateway job detail and uses the same outcome normalizer. Its body
limit accounts for the retained original request as well as the result.

Native mutation receipts are scoped to one runtime generation and are not durable
exactly-once guarantees across restarts or retention expiry. A timeout does not undo
an accepted edit. Adapter work has an eight-second deadline; gateway HTTP requests
have a seven-second deadline. Logs contain correlation/status only, not file text
or diffs.

## Deployment and adoption

Deployed and verified on 2026-09-21. The build command remains a dry run. Public HTTP exposes only
GET `/health`; submission and callbacks use private service bindings.

1. Use compatible gateway and native v5 builds.
2. Deploy `managed-agents-tool-pi-edit`; provision a dedicated
   `EXECUTION_GATEWAY_API_KEY` for a gateway user configured with the shared v3
   callback URL and the callback router's signing secret.
3. Deploy the callback router afterward. Its repository config adds
   `tool-pi-edit-v1 → EDIT_EVENTS → PiEditCallbacks`.
4. An adopting caller binds `PiEdit` and configures a matching session namespace
   and route. The committed edit-worker config deliberately has `SESSION_ROUTES: "{}"`.

## Verification

```sh
pnpm --filter @managed-agents/contracts check
pnpm --filter @managed-agents/tool-pi-edit-workers check
pnpm --filter @managed-agents/execution-gateway-callback-workers check
```

Workerd tests use private service RPC, the actual signature-verifying callback
router, SQLite Durable Object and SessionDriver with a fake gateway. They cover
replay, early/duplicate callbacks, lost durable receipts, deadline behavior, malformed
receipts, structured rejections/partial results, and serialized request limits.

Optional cross-repository integration runs an isolated native runtime and temporary
files; it does not modify the connected user daemon:

```sh
PROCESS_EXECUTION_TEST_BINARY=/absolute/path/to/process-execution \
  pnpm --filter @managed-agents/tool-pi-edit-workers test
```

It exercises actual replacement matching, BOM/CRLF and Unicode, multiple edits,
missing/ambiguous/overlapping/no-change rejections, symlinks, invalid files, the
5 MiB input/output boundaries, and replay after a subsequent edit through the
worker/callback/session stack.
