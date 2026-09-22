# App-owned machine enrollment, protocol v1

The daemon supports any HTTPS **app enrollment endpoint** implementing this
contract. It is not the gateway's `/v1/machines` route. Accounts, browser login,
ownership and approval live in your app; the gateway remains unchanged.

The interaction uses the browser-approval/private-polling separation described in
[device authorization](https://www.rfc-editor.org/rfc/rfc8628.html), but this JSON
contract is **not an OAuth-compatible token endpoint**. No inbound port, browser
callback listener, or stdin secret is required. The CLI prints a link for the user
to open in any browser/device; it does not launch a browser automatically.

## User commands

```sh
process-execution-daemon register --url https://app.example/api/machines/enroll
process-execution-daemon connect
process-execution-daemon update

# Later: another approval, using the saved app URL.
process-execution-daemon register
```

`--name "My Mac"` is optional; the app can collect a name during approval.
Plain `register` reuses the saved app URL/name. Interrupted attempts resume with
the same private credential; after success, denial, or expiry, a new invocation
creates a fresh attempt. Changing URL/name while an attempt is pending is rejected
to avoid losing a credential being rotated.

First registration only saves credentials; `connect` starts the service. For an
already-running daemon, registration waits without stopping it, then saves the
approved credential and restarts it. Successful re-enrollment ends native sessions
and changes runtime generation. Denial, timeout, or malformed responses do not
overwrite local credentials or stop the daemon. Remote rotation may already have
invalidated the old credential, so the backend must retain a recoverable response.

## Start

Before network I/O, the daemon persists an attempt UUID and private random bearer
credential (244 bits of entropy) in mode-0600 `enrollment.json`. It sends:

```http
POST /api/machines/enroll
Authorization: Bearer <private-enrollment-credential>
Content-Type: application/json
```

```json
{
  "protocolVersion": 1,
  "action": "start",
  "registrationId": "10000000-0000-4000-8000-000000000001",
  "name": "My Mac",
  "existingMachine": null,
  "daemon": { "version": "0.1.0", "os": "macos", "arch": "aarch64" }
}
```

`name` may be null. On re-enrollment, `existingMachine` is an identity hint:

```json
{
  "gatewayUrl": "https://execution-api.acentric.dev/",
  "machineId": "10000000-0000-4000-8000-000000000002"
}
```

This is **not proof of ownership**. No old daemon/execution secret or management
secret is sent to this endpoint. The app must validate that the logged-in approving
user owns the hinted machine. Never rotate based only on caller-supplied IDs.

Store a hash of the private credential, bound to the immutable start request and
attempt ID. Repeated `start` calls with identical body/credential must recover the
same attempt/outcome. Reject a different credential or body for an existing ID.
A browser link, user code or attempt ID alone must never authorize polling.

## Pending approval and polling

Return HTTP 200 or 202, `Content-Type: application/json`, `Cache-Control: no-store`:

```json
{
  "protocolVersion": 1,
  "registrationId": "10000000-0000-4000-8000-000000000001",
  "status": "pending",
  "verificationUrl": "https://app.example/machines/approve?request=public-browser-reference",
  "userCode": "ABCD-1234",
  "expiresAt": 1900000000000,
  "intervalSeconds": 2
}
```

`expiresAt` is an absolute Unix timestamp in **milliseconds**, at most 15 minutes
from start. `intervalSeconds` is 1–30. `userCode` is 1–32 ASCII letters/digits or
hyphens. Use random, collision-resistant, short-lived codes and rate-limit guesses.
The CLI prints the URL/code and asks the user to check that the browser displays
the same code before approving. The URL can use another HTTPS origin (app vs API
subdomains), but must not contain the private enrollment credential.

Require login, explicit consent and CSRF protection for approval; never approve
on a GET/link visit. Show the account, device details, code and requested machine
access. Escape untrusted device names. Do not return gateway secrets to the browser.

The daemon posts to the **same exact enrollment URL**, with the same bearer header:

```json
{
  "protocolVersion": 1,
  "action": "poll",
  "registrationId": "10000000-0000-4000-8000-000000000001"
}
```

Return the complete `pending` response until approval, with unchanged URL/code.
The daemon honors polling intervals. Timeouts, connection failures, HTTP 429 and
5xx back off up to 60 seconds without extending the attempt lifetime. Numeric
`Retry-After` seconds are supported (clamped to 1–60). Other non-2xx responses end
the invocation without printing server bodies. Redirects are disabled. Bodies
are limited to 16 KiB; unknown fields/statuses and mismatched IDs/versions fail.
For local tests only, `--allow-insecure-loopback` allows HTTP loopback endpoints.

## Approval and gateway enrollment

After browser approval, the backend:

1. Validates the account's ownership and the exact attempt being approved.
2. For a new machine, persists a UUID and calls gateway `POST /v1/machines` with
   `{machineId,name}` and its `MANAGEMENT_SECRET`. Recover retries with the same
   UUID/name rather than generating another machine.
3. Stores the returned `executionSecret` against the user's machine, server-side.
4. For an existing owned machine, rotates **only its daemon secret** through
   `POST /v1/machines/:id/secrets/rotate`, `{kind:"daemon",expectedVersion}`.
   Persist the expected version before calling; identical retries recover the
   same rotation response. Serialize rotations per machine. Never rotate again
   for each poll or repeated approval click. Keep the existing execution secret
   unless intentionally invalidating harness access as a separate action.
5. Durably records the approved response before exposing it to the daemon.

Successful `poll` or recovery of an already-approved `start` returns:

```json
{
  "protocolVersion": 1,
  "registrationId": "10000000-0000-4000-8000-000000000001",
  "status": "approved",
  "gatewayUrl": "https://execution-api.acentric.dev",
  "machineId": "10000000-0000-4000-8000-000000000002",
  "daemonSecret": "md1.10000000-0000-4000-8000-000000000002.1.<43-character-secret>"
}
```

The daemon secret is the **only** gateway credential returned. No execution
secret, refresh token or permanent app authentication token belongs in this reply.
Return the identical approved response on authenticated retries for the attempt's
remaining lifetime; do not consume it on the first poll. A new attempt must never
return `approved` without browser approval.

The daemon validates HTTPS gateway origin and the `md1` credential's machine ID,
persists approval for crash recovery, then atomically replaces `credential.json`.
It never prints the credential. A state directory remains bound to one gateway
and machine ID to protect its journal/outbox. Another identity requires a separate
`--state-dir`. First app enrollment does not create `execution-secret.json`; an
existing file from direct registration is left alone, never read or updated.

After installation, private attempt/approval data is cleared from `enrollment.json`;
only the app URL/name and local-development setting remain. A new `register`
starts another browser approval, not a replay of the previous success.

## Denial and expiration

Return HTTP 200 with no additional fields:

```json
{
  "protocolVersion": 1,
  "registrationId": "10000000-0000-4000-8000-000000000001",
  "status": "denied"
}
```

`"status":"expired"` is also supported. The daemon clears pending data, preserves
installed credentials, and exits with an actionable error. Expire app-side attempts
and browser links even if the client disappears. Never log bearer headers, gateway
secrets or full enrollment responses.

## Direct-registration escape hatch

```sh
process-execution-daemon register \
  --gateway-url https://execution-api.acentric.dev \
  --name "My Mac" < /secure/path/management-secret
```

This retains direct registration, including local storage of both machine secrets.
It does not go through the app or establish account ownership. `--gateway-url`
explicitly selects it even when an app URL is saved. The daemon must be stopped
for direct registration/configuration.
