# Stateless Pi-style read operation worker

Implements `tool-pi-read/read/v1` through the execution gateway's existing `filesystem.read_file` operation. The gateway owns file access, durable jobs, idempotency and callback retries. This worker validates inputs, formats text, uploads images and admits results into the session DO.

**Deployed and tested on 2026-09-21; not adopted by a production harness.** `minimal-bash/v7` remains bash-only. The final deployment has an empty `SESSION_ROUTES` and no session namespace binding. A caller must configure its return namespace before using the private submission binding. Production tests temporarily bound an authenticated test host, exercised the real gateway/Mac/router/SQLite admission path, then removed that route after delivery verification.

## Submission and model schema

`PI_READ_TOOL` exposes Pi's arguments: `{ path: string, offset?: number, limit?: number }`. Offset is a one-based line number; limit is a line count. Both must be positive safe integers when present. Paths are passed directly to the execution host: absolute paths and paths relative to cwd work, with no local `~`, `@` or macOS filename normalization.

The private `PiRead.submit` binding accepts:

```ts
{
  destination: { routeKey, sessionId },
  submission: {
    operationId, submissionId,
    request: {
      provider: "tool-pi-read", type: "read", version: "v1",
      input: { machineId, cwd, path, offset?, limit? }
    }
  }
}
```

The host supplies machineId and absolute cwd. Unknown fields, NUL paths, invalid paging and model-supplied routing/credentials are rejected. After checking the allowlisted return route, the adapter calls authenticated `POST /v1/jobs`:

```ts
{
  machineId,
  idempotencyKey: "pi-read-v1:" + sha256(submissionId),
  clientContext: {
    receiver: "tool-pi-read-v1", routeKey, sessionId,
    operationId, submissionId, machineId, path,
    offset: offset ?? null, limit: limit ?? null
  },
  request: {
    operation: "filesystem.read_file",
    params: { path, cwd, max_bytes: 5242880 }
  }
}
```

The gateway reads the whole file before this worker applies line paging. **The maximum raw file size is 5 MiB (5,242,880 bytes), even with offset/limit.** Larger files produce a completed tool result with `isError: true` and `READ_FILE_TOO_LARGE`; they do not fail the operation. A future harness can return this error to the model and continue.

Normal submissions return `{ result: { status: "accepted", jobId } }`. A replay finding a terminal job fetches its retained detail, checks correlation and returns `completed` with the same normalized outcome. This is the only gateway result GET. Ambiguous submission/transport failures throw so the runtime retries the original identity. Known pre-acceptance rejections return `rejected`.

## Completion and output

The common execution callback router verifies v3 HMAC events and forwards `tool-pi-read-v1` to the private `PiReadCallbacks.acceptGatewayEvent` entrypoint. The adapter checks the exact read context, machine, idempotency key, protocol version 4 or 5, request/job ID and runtime generation. It validates file metadata, canonical base64 and the SHA-256 digest before formatting.

Text output follows Pi's head truncation semantics: at most 2,000 complete lines or 50 KiB, with continuation hints, UTF-8 decoding, one-based offset/limit and an overlong-first-line hint. The final notice is outside the content cap, as in Pi. Missing files, directories, filesystem I/O errors and offsets beyond EOF are completed `isError: true` tool results.

Images are identified by magic bytes, not filename extensions. JPEG, PNG, GIF and WebP are uploaded; Windows BMP is converted to PNG first. BMP decoding is bounded to four million pixels and conversion output to 10 MiB. Unsupported/corrupt BMPs return a tool error. SVG and APNG follow Pi's text path. Paging arguments do not slice images.

```ts
{
  status: "succeeded",
  result: {
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", url: "https://imagedelivery.net/ACCOUNT_HASH/IMAGE_ID/piread" }
    ],
    isError: false,
    details: {
      gatewayJobId, machineId, path,
      file: { sizeBytes, sha256, modifiedAt, isSymlink },
      image: { id, url, mimeType, originalMimeType }
    }
  }
}
```

Text results use the same envelope with text content and optional Pi-style `details.truncation`. Errors carry `details.error: { code, message }`. No base64 image enters session history. The image URL shape already satisfies the shared LLM message contract.

Gateway failures/unknown outcomes remain failed operations. Malformed or miscorrelated callbacks, image-service outages and missing credentials throw and are not acknowledged. Explicit image upload rejection with HTTP 413/415/422 becomes a completed tool error; other HTTP failures, including ambiguous 400/conflict responses, remain retryable delivery errors.

Only after formatting/upload and a matching durable DO admission receipt does the adapter acknowledge the router. The router then returns 204. Lost receipts and duplicates recover through the existing session deduplication. There are no local databases, Queues, polling, crons or background completion handoffs.

## Image storage and replay

Images use the [Cloudflare Images upload API](https://developers.cloudflare.com/images/storage/upload-images/upload-file-worker/) and a deterministic [custom image ID](https://developers.cloudflare.com/images/storage/upload-images/upload-custom-path/), derived from operation ID, gateway job ID and file digest. The worker checks for that image first, uploads if absent and recovers the same ID after a lost upload response or concurrent creation. Stored metadata identifies the adapter and original/uploaded digests. A mismatched image is never reused.

URLs use the configured named variant. Create `piread` with `fit: "scale-down"`, `width: 2000`, `height: 2000`, `metadata: "none"` for bounded model delivery. The live API rejected the original hyphenated name `pi-read`; the configured and tested name is `piread`. Resizing occurs in Images delivery, not in the execution gateway. This implementation returns MIME/URL information without Pi's local resize-coordinate annotations. Delivery may negotiate a different format from the uploaded file; image details describe the upload, while the URL's HTTP Content-Type describes its delivered bytes.

Custom-ID images use `requireSignedURLs: false`: URLs are accessible to anyone holding the link and do not expire. This worker adds no image deletion/retention scheduler. Retain images and the configured variant for conversation history; retain the Images account/variant configuration and conversion behavior for replay consistency. Replacing or deleting stored images can break historical URLs. Storage/delivery require an enabled Images plan.

Submission/replay and callback handling each have an eight-second total deadline; HTTP requests cap at seven seconds and support abort. The router also has an eight-second total budget. Image uploads share this budget with DO admission. The gateway owns retry/redelivery after acceptance; exhausted gateway retries require operator redelivery. A timed-out RPC may still admit, so retries must preserve identity.

## Configuration and eventual adoption

| Binding/variable | Purpose |
| --- | --- |
| `EXECUTION_GATEWAY_URL` | HTTPS gateway origin |
| `EXECUTION_GATEWAY_API_KEY` | Secret for the dedicated execution user |
| `SESSION_ROUTES` | JSON route key to session namespace binding allowlist |
| Session namespace binding(s) | Added together with routes by the future host |
| `CLOUDFLARE_IMAGES_ACCOUNT_ID` | Account storing uploaded images |
| `CLOUDFLARE_IMAGES_API_TOKEN` | Secret scoped to that account with Images read/write permissions |
| `CLOUDFLARE_IMAGES_VARIANT` | Existing named delivery variant; defaults to `piread` in Wrangler config |

Text reads do not require Images credentials. Configure `.dev.vars` from the example for local use; use Wrangler secrets for production tokens. The public fetch handler exposes only health, and health is not readiness. Restrict callback bindings to the trusted signature-verifying router. Cwd is a path resolution base, not a filesystem sandbox.

For deployment, configure Images and secrets, then deploy this worker before deploying the router's new `READ_EVENTS` service binding. The router's source allowlist now includes both bash and read. The gateway user must use v3 callbacks and the existing common callback URL. No gateway protocol changes are needed.

Future harness adoption is a separate change: bind `PiRead`, add an allowlisted return namespace here, register `tool-pi-read/read/v1`, advertise `PI_READ_TOOL`, supply trusted machine/cwd and render `ReadResult` into model tool messages. None of those harness changes is included now.

## Checks

`pnpm --filter @managed-agents/tool-pi-read-workers check` runs source/test typechecks, formatting tests, real workerd RPC/SQLite integration using the production callback router and a test-only harness, and a dry-run build. Coverage includes the 5 MiB boundary, file errors, images, BMP conversion, lost uploads/receipts, concurrent callbacks, early delivery, terminal replay/correlation, restart recovery and deadlines. Gateway and Images HTTP services are fakes; checks do not upload real files or deploy resources.

The separate 2026-09-21 production run passed 16 read scenarios, text/image terminal replay and manual callback redelivery, plus an existing minimal-bash/v7 regression. Five non-sensitive test images remain in Images storage; credentials are installed as Worker secrets. Hosted Images storage was activated with user approval at a $5/month minimum plus delivery/usage charges.

## Execution protocol compatibility

Callbacks and terminal job replay accept numeric execution protocol versions **4
and 5**, preserving retained v4 jobs during the v5 rollout. Other versions and
malformed version fields are rejected; job, runtime generation and tool-specific
receipt validation still apply. This is independent of the signed webhook's
`schemaVersion: 3`. Requests use the existing gateway operation envelope, which
leaves native protocol-version selection to the gateway.
