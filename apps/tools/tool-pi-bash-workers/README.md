# Pi-style bash worker

Stateless `tool-pi-bash/bash/v1` provider using the new execution gateway's
`POST /v1/machines/:machineId/requests` and one native `execution.exec` operation. This breaking migration
removes the old jobs API, `execution.run`, shared gateway key and HMAC callback flow.

## Model arguments and behavior

Pi's model schema remains `{ command: string, timeout?: number }`. The trusted
caller supplies `machineId` and absolute `cwd`. Commands run in non-login Bash,
with pipes and closed stdin. The core merges stdout/stderr in capture order.
No PTY, yielded session or follow-up interaction is needed for this tool.

Timeout is optional seconds, with no tool-imposed default. Fractional milliseconds
are truncated and sub-millisecond values become 1 ms, matching Pi/Node timers. On
timeout, the core terminates the command and returns captured output. Runtime
lifecycle and configured resource limits still apply.

The core returns up to 64 KiB of tail text and retains the full raw output in a
machine-local artifact. The worker applies Pi's **2,000-line / 50 KiB** tail limit,
complete final lines where possible, and a Unicode-safe partial final line when
one line exceeds the cap. Truncation notices include the retained file path.
Empty output is `(no output)`; known nonzero exits, signals, timeouts, terminated
commands and start failures retain their output and produce `isError: true`.
Incomplete captures explicitly identify partial output and also produce tool errors.

The core now decodes raw bytes to text; invalid UTF-8 is replaced there. Raw byte
counts and decoded text counts are distinct. The worker does not invent full-file
line counts when it only has an upstream tail.

## Required Session DO envelope

Private `PiBash.submit` returns `{ result }` and accepts:

```ts
{
  destination: { routeKey, sessionId },
  execution: { token, runtimeGeneration },
  submission: {
    operationId, submissionId,
    request: {
      provider: "tool-pi-bash", type: "bash", version: "v1",
      input: { machineId, cwd, command, timeout? }
    }
  }
}
```

The caller pins the runtime and supplies that machine's execution secret.
The worker checks the secret's machine identity; the gateway authenticates its
hash and current version. Secrets stay outside model input and history. The
callback receiver is fixed to `tool-pi-bash-v1`; its context carries the session
route, operation identities and input fingerprints. No temporary grant or
account-wide execution credential is involved.

Native submission:

```ts
{
  requestId: "pi-bash-v1:<SHA-256 of submissionId>",
  runtimeGeneration,
  operation: {
    operation: "execution.exec",
    params: {
      cwd, env: {}, tty: false,
      command: { type: "shell", script: command, shell: { executable: "bash", kind: "bash" }, login: false },
      completion: { mode: "finished", timeout_ms: timeoutMillisecondsOrNull },
      output: { strategy: "tail", max_bytes: 65536, retain_full_output: true }
    }
  },
  callback: { receiver: "tool-pi-bash-v1", context: { /* routeKey, sessionId; identities, cwd, command digest, timeout seconds */ } }
}
```

Context contains neither command text nor credentials. Pin runtime, input
and submission identity across retries; replacing the execution secret for the same machine preserves the
request hash. Never retarget an uncertain command to a new runtime or request ID.

## Acceptance and completion

DO → PiBash → execution API → Machine DO → daemon. HTTP 202 confirms daemon
acceptance. The provider's generic `jobId` carries the request ID. The worker's
seven-second submission deadline does not bound command duration: execution remains
on the machine and completion returns later.

Daemon → Machine DO → private `PiBashCallbacks.acceptExecutionResult` →
Session DO `acceptToolCompletion`. The worker validates completion hashes and machine/
runtime identity, formats the terminal native result, and requires a matching durable
Session DO admission receipt before returning the flat protocol receipt:

```ts
{ status: "accepted", deliveryId, requestId, requestHash, resultHash }
```

Machine then acknowledges delivery to the daemon. Callback formatting/admission
has a six-second budget. Early callbacks, duplicate delivery and lost acceptance or
admission receipts use the same request identity and durable Session DO deduplication.
There are no job-detail GETs, adapter D1/DO/Queue, polling or follow-up exec calls.
Daemon journals own native replay and result redelivery within their retention bounds.

Unknown/lost execution remains a failed `BASH_EXECUTION_UNKNOWN` operation and never
authorizes rerunning the command. Other native/infrastructure errors remain failed
operations. Malformed or still-running native receipts fail completion admission.
A timeout of the HTTP/RPC adapter does not cancel an accepted command. The caller
can cancel the individual request with `request.cancel`.

## Result metadata changes

The model still receives Pi-style `content` and `isError`. Details now contain:

- `requestId`, `machineId`, `runtimeGeneration`, `wallTimeSeconds`, `originalBytes`.
- `reason`, `exitCode`, `signal`, `timedOut` and truncation metadata.
- `fullOutputPath` and `outputFile: { artifactId, sizeBytes, complete, expiresAt }`.

Legacy `gatewayJobId`, `runId`, `executionHandle` and output-file SHA-256 are removed.
The native receipt does not expose those fields. `expiresAt` is nullable if no expiry
is supplied; artifacts follow core retention and runtime cleanup, so historical
paths are not permanent. Output artifacts can be partial under capture/storage limits.

## Configuration and rollout

Set `EXECUTION_GATEWAY_URL=https://execution-api.acentric.dev`, `SESSION_ROUTES` and
matching session namespace bindings. Node compatibility is enabled.
The committed Machine config routes
`tool-pi-bash-v1 → BASH_EVENTS → managed-agents-tool-pi-bash#PiBashCallbacks`.
The gateway calls this receiver directly through a private service binding.

Both production harnesses now supply execution context through their shared host
integration. Coordinate the rollout with those hosts,
drain old bash operations, deploy this worker before the Machine binding, then
use its matching private callback binding. Public HTTP exposes only GET `/health`.
This migration has been tested locally and has not been deployed in this change.

## Verification

`pnpm --filter @managed-agents/tool-pi-bash-workers check` runs typechecks, formatter,
deadline and safe-logging tests, workerd/SessionDriver/SQLite integration, and a dry-run
build. Coverage includes secret replacement, unchanged replay identity, early/duplicate
callbacks, lost durable receipts, restart, errors and malformed native receipts.

The native integration builds the repository Rust daemon with Cargo and runs the real
local gateway/Machine stack. It verifies stdout/stderr, UTF-8, nonzero exits,
process timeout, retained artifacts, 2,000-line and 50 KiB tails, a command lasting
longer than HTTP submission's budget, and replay without duplicate side effects.
It uses temporary files and leaves the installed daemon alone.


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
