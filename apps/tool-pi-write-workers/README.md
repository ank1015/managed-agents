# Pi-style write worker

Standalone stateless `tool-pi-write/write/v1` provider. It submits one
`filesystem.write_file` job with `mode: "overwrite"` to the execution gateway.
The `pi-no-compaction/v1` harness uses this worker; `minimal-bash/v7` still exposes only bash.

## Input and output

`PI_WRITE_TOOL` exposes Pi's required model arguments:

```ts
{ path: string; content: string }
```

The trusted caller supplies `machineId` and absolute `cwd` in `WriteInput`. Paths
use the machine's normal filesystem resolution; there is no tilde or `@` expansion.
Empty content is valid. The worker preserves UTF-8 content, including newline style,
BOM, Unicode and NUL characters; it does not append a newline or invoke a shell.
Malformed arguments, extra properties and NUL characters in paths are rejected.

Success matches the inspected Pi tool's text:

```ts
{
  content: [{ type: "text", text: "Successfully wrote to nested/file.txt" }],
  isError: false,
  details: {
    gatewayJobId, machineId, path,
    file: { path: absolutePath, mutationId, sha256, bytesWritten, disposition }
  }
}
```

Pi's direct result has `details: undefined`; this adapter adds correlation and file
receipt metadata, plus explicit `isError`. Both `applied` and `already_applied`
receipts produce the same success text. The input path is used in that text;
`details.file.path` preserves the machine's returned absolute path.

Ordinary filesystem errors (`io`, `not_found`, `invalid_argument`, `resource_limit`)
complete with `isError: true` so an adopting harness can pass the result to the model.
Host resource-limit messages are preserved: a limit can mean a lower write cap or
an exhausted mutation registry, not necessarily a large file. Infrastructure,
idempotency and unrecognized protocol errors remain failed operations.

### Size limits

New content is capped at **5 MiB (5,242,880 UTF-8 bytes)**. Larger content that fits
the submission transport returns a completed `WRITE_FILE_TOO_LARGE` tool error
without a gateway POST. It has a stable `local:pi-write-v1:<hash>` provider receipt
ID and no `details.gatewayJobId`. A local receipt is not a gateway job.

The generic operation input budget remains **8 MiB of serialized JSON**, including
escaping and metadata. Inputs beyond that transport budget are rejected before
execution. A 5 MiB string with extensive JSON escaping can exceed this separate
budget. The gateway receives base64 bytes within its own 8 MiB request limit.

Future harness integration also needs to account for the existing **1,900,000-byte
LLM outcome limit** and inline session history limits: the standalone worker's
5 MiB capacity does not increase those limits.

## Execution contract

```json
{
  "operation": "filesystem.write_file",
  "params": {
    "mutation_id": "pi-write-v1:<submission SHA-256>",
    "cwd": "/workspace/project",
    "path": "nested/file.txt",
    "data_base64": "SGVsbG8K",
    "create_parent_directories": true,
    "mode": "overwrite"
  }
}
```

No precondition is sent. Requires protocol v4 or v5 builds supporting
`runtime.filesystem.overwrite`; provision a compatible gateway and host runtime
before use. Unsupported requests surface as errors; there is no shell fallback.

The updated runtime creates parents, follows final symlinks (including dangling
links), and stages bytes in the target directory before atomic rename. A small new
file can replace an existing file above the read limit. Other hard links retain the
old inode; identical readable content can return `already_applied` without touching
the file. These atomic-replacement details differ from Pi's direct `fs.writeFile`.
Runtime mutations are serialized; the adapter does not add a queue or promise a
submission order across independent sessions. Callback cancellation/timeout does
not undo an accepted write.

## Submission, callbacks and recovery

- `PiWrite.submit` is a private service entrypoint returning `{ result }`.
- Gateway idempotency key and runtime mutation ID are both
  `pi-write-v1:SHA256(submissionId)`. Payload/routing changes under the same key
  conflict instead of overwriting a second time.
- Signed `clientContext` contains receiver `tool-pi-write-v1`, session route,
  operation/submission/machine identity, cwd/path, content byte count and SHA-256.
  It contains neither file content nor credentials.
- `PiWriteCallbacks.acceptGatewayEvent` is a separate private entrypoint bound only
  by the signature-verifying callback router. It returns `{ receipt }`.
- The adapter validates callback identity, protocol version, generation, mutation
  ID, content digest, byte count and receipt shape. A callback does not fetch the
  job or issue another write.
- Completion is sent to an allowlisted session namespace. Only its matching durable
  admission receipt permits acknowledgement. The gateway retries failed delivery;
  session admission deduplicates callbacks, including after a lost receipt.
- Terminal submission replay fetches gateway job detail, verifies retained context,
  and uses the same outcome normalizer. It never creates a replacement job.
- `unknown` becomes execution failure `WRITE_OUTCOME_UNKNOWN`: the file may have
  changed. Inspect it before explicitly deciding on another write. In-memory
  mutation receipts are scoped to a runtime generation; they are not a durable
  exactly-once guarantee across host restarts or gateway retention expiry.
- Adapter work has one eight-second deadline and seven-second gateway HTTP calls.
  Late RPC completion may still be admitted and is handled through deduplication.

No adapter database, Durable Object, Queue, cron or background delivery is needed.
Public HTTP exposes only `/health`; submission is private RPC. Logging carries
identifiers/status/duration and never file content or base64 payloads.

## Configuration and deployment

The committed worker config routes `pi-no-compaction-v1` to its session namespace.
Any additional caller must configure its namespace binding and route together. Unknown
routes fail before gateway submission.

1. Deploy compatible execution gateway and host-runtime builds.
2. Deploy `managed-agents-tool-pi-write` and provision its dedicated
   `EXECUTION_GATEWAY_API_KEY` secret for a user with the shared v3 callback URL.
3. Deploy the callback router after the write worker exists. Its config includes
   `tool-pi-write-v1 → WRITE_EVENTS → PiWriteCallbacks` alongside bash and read.
4. The Pi harness binds private `PiWrite` and has an allowlisted session namespace
   in the write worker.

Deployed and tested on the benchmark Mac on 2026-09-21.

## Verification

```sh
pnpm --filter @managed-agents/tool-pi-write-workers check
pnpm --filter @managed-agents/contracts check
```

Workerd/Miniflare tests use the actual callback router, private service RPC, SQLite
DO and `SessionDriver`, with a fake gateway. They cover exact bytes and schema,
5 MiB boundary, error results, signed receipt validation, early callbacks, lost
acceptance, terminal replay, concurrent duplicates, lost durable receipts/restart,
and delivery deadlines. They do not invoke production services.

An optional cross-repository test runs the same worker/callback/session stack with
real filesystem operations through a local `process-execution` binary. Build the
updated binary in the execution-providers checkout, then from this repository:

```sh
PROCESS_EXECUTION_TEST_BINARY=/absolute/path/to/process-execution \
  pnpm --filter @managed-agents/tool-pi-write-workers test
```

It uses an isolated temporary runtime and files, checks new files, overwrite,
empty content, UTF-8, parents, symlinks/dangling links, hard-link behavior, replacing
an old file above 5 MiB, exact 5 MiB content, filesystem errors and old mutation
replay after a later write. Without the environment variable, this test is skipped.

## Execution protocol compatibility

Callbacks and terminal job replay accept numeric execution protocol versions **4
and 5**, preserving retained v4 jobs during the v5 rollout. Other versions and
malformed version fields are rejected; job, runtime generation and tool-specific
receipt validation still apply. This is independent of the signed webhook's
`schemaVersion: 3`. Requests use the existing gateway operation envelope, which
leaves native protocol-version selection to the gateway.
