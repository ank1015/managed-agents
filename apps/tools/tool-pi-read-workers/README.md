# Pi-style read worker

Stateless `tool-pi-read/read/v1` provider using the new execution gateway's
`POST /v1/machines/:machineId/requests` and native `filesystem.read` operation. This breaking migration
removes the old jobs API, shared gateway API key and HMAC callback router contract.

## Model arguments and output

Pi's arguments remain `{ path: string, offset?: number, limit?: number }`. Offset
is a one-based line number; limit is a line count. The trusted caller supplies
`machineId` and absolute `cwd`. Paths use the machine's normal resolution without
`~` or `@` expansion. Extra fields and invalid paging/path values are rejected.

The worker requests bytes in one operation, then applies the existing Pi formatting:

- At most 2,000 complete lines or 50 KiB of text, with continuation and overlong-line
  hints. UTF-8 decoding, BOM, CRLF, empty files and trailing newlines are preserved.
- **5 MiB maximum raw file size**, including with offset/limit. Oversized files are
  completed tool errors. The daemon also enforces its configured file limit.
- JPEG, PNG, GIF and WebP are detected by magic bytes and uploaded to Cloudflare
  Images. Windows BMP is converted to PNG with a four-megapixel decode limit and
  10 MiB conversion-output limit. SVG/APNG follow the existing text path.
- Paging does not slice images. Images enter session history as URLs, never base64.

Results retain `content`, `isError`, file/truncation/image metadata and error
messages. **`details.requestId` replaces `details.gatewayJobId`.** Native bytes are
validated against canonical base64, declared size and SHA-256 before formatting.

Known native file errors, including I/O and resource limits, become `isError: true`
results. The daemon conservatively flags some of these uncertain across all
operations; a read has no mutation to reconcile, so its file error can still reach
the model. Unknown execution/daemon failures remain failed operations with
`READ_OUTCOME_UNKNOWN`. Malformed receipts are never admitted.

## Required DO execution context

`PiRead.submit` is private RPC returning `{ result }` and requires:

```ts
{
  destination: { routeKey, sessionId },
  execution: {
    gatewayUrl, token, runtimeGeneration,
  },
  submission: {
    operationId, submissionId,
    request: {
      provider: "tool-pi-read", type: "read", version: "v1",
      input: { machineId, cwd, path, offset?, limit? }
    }
  }
}
```

The caller pins the runtime and supplies that machine's execution secret.
The worker checks the secret's machine identity; the gateway authenticates its
hash and current version. Secrets stay outside model input and history. The
callback receiver is fixed to `tool-pi-read-v1`; its context carries the session
route, operation identities and input fingerprints. No temporary grant or
account-wide execution credential is involved.

Pin input, request identity, runtime on retries; replace only with a same-machine
token. The native request is:

```ts
{
  requestId: "pi-read-v1:<SHA-256 of submissionId>",
  runtimeGeneration,
  operation: { operation: "filesystem.read", params: { path, cwd, mode: "bytes" } },
  callback: { receiver: "tool-pi-read-v1", context: { /* routeKey, sessionId; machine/runtime, operation IDs, path/cwd, paging */ } }
}
```

No credentials or file contents are placed in callback context. HTTP 202 means
accepted, not completed; the provider's generic `jobId` carries this request ID.
Lost/malformed acceptance retries the same request. No job-detail lookup or second
native read is performed.

## Completion and image recovery

Daemon → Machine DO → private `PiReadCallbacks.acceptExecutionResult` →
Session DO `acceptToolCompletion`. The worker validates completion identity and hashes,
formats text/uploads the image, and requires a matching durable Session DO receipt
before returning `{ status: "accepted", deliveryId, requestId, requestHash, resultHash }`.
Machine then acknowledges the daemon. Early callbacks, duplicate delivery and
lost admission receipts are handled by the existing durable Session DO deduplication.

Image IDs are deterministic from operation ID, request ID and source digest.
Retries look up the same image and validate its metadata, recovering lost upload
responses and concurrent creation. Definitive Images 413/415/422 rejection becomes
a tool error; outages, bad metadata and missing credentials remain delivery errors.

Images use the configured `piread` variant (scale-down to 2000 × 2000 with metadata
removed). URLs use `requireSignedURLs: false`, are accessible to holders of the link,
and do not expire. This worker adds no retention/deletion scheduler. Preserve the
account, variant and objects for historical conversation URLs. Delivery may negotiate
a different format from the upload. BMP conversion remains in this worker.

Submission has a seven-second deadline. Read completion has a **25-second budget**,
including upload and DO admission; individual Images requests allow 20 seconds.
The committed Machine config uses **30 seconds** for callback admission.
Keep that gateway setting above the worker budget. Failed delivery retries the
retained daemon result; no read-worker database, DO, Queue or early ACK is introduced.
Timeout does not cancel native execution, and a late DO commit is deduplicated.

## Configuration and rollout

- Gateway URL comes from the session's immutable `config.executionGatewayUrl` via `execution.gatewayUrl`; no deployment-wide URL setting.
- Allowlisted `SESSION_ROUTES` and matching session namespace bindings.
- `CLOUDFLARE_IMAGES_ACCOUNT_ID`, account-scoped `CLOUDFLARE_IMAGES_API_TOKEN`, and
  `CLOUDFLARE_IMAGES_VARIANT` for image reads. Text needs no Images credentials.
- Machine: `tool-pi-read-v1 → READ_EVENTS → managed-agents-tool-pi-read#PiReadCallbacks`.

Production harness execution-context integration is implemented. Coordinate its
deployment and drain old reads before rollout. Deploy this worker before the
Machine callback binding; remove the legacy router's read binding. Public
HTTP exposes only GET `/health`. Cwd is a resolution base, not a filesystem sandbox.
See the [earlier deployment record](../../../execution/DEPLOYMENT.md). Deploy matching hosts and tools for the per-session gateway URL contract.

## Verification

`pnpm --filter @managed-agents/tool-pi-read-workers check` runs typechecks, formatting,
byte-integrity and image tests, workerd RPC/SQLite tests and a dry-run build. Coverage
includes stable identity/secret replacement, early and duplicate callbacks, lost receipts,
DO restart, upload failures/recovery, size limits and error classification.

The native integration test builds the repository's Rust daemon with Cargo and uses
a temporary daemon plus the real local gateway API/Machine and SessionDriver.
It reads actual files and an image through the full stack; the Images HTTP endpoint
is faked. Tests do not modify the installed daemon or upload production images.


The harness supplies `execution: { gatewayUrl, token, runtimeGeneration }` on every submit.
The token must be this machine's `me1.…` execution secret. This worker neither
stores nor discovers, rotates or refreshes it. Different submissions can target
different gateways and machines with different tokens; the harness owns that choice.
Credential storage and replacement are outside this tool's contract.

Any gateway implementing the [tool-facing gateway contract](../GATEWAY-CONTRACT.md)
is supported. User credentials, temporary grants, daemon secrets, legacy jobs
responses and public webhook envelopes are rejected; there is no compatibility
fallback. Malformed replies after dispatch are uncertain and must be retried with
the same request identity. A replacement secret does not change that identity.
