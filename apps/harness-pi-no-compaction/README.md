# Pi no-compaction Worker host

> The [deployment record](../../execution/DEPLOYMENT.md) describes the earlier machine-secret release.
> The per-session gateway URL contract requires matching hosts/tools and fresh sessions.

Hosts [`pi-no-compaction/v1`](../../packages/harness-pi-no-compaction/README.md) in a
fresh SQLite Durable Object class, `PiNoCompactionSessionV1`. Worker name:
`managed-agents-harness-pi-no-compaction-v1`; route key: `pi-no-compaction-v1`.

## Bindings

| Binding | Destination |
|---|---|
| `PI_NO_COMPACTION_SESSIONS` | This host's `PiNoCompactionSessionV1` namespace |
| `LLM` | `managed-agents-llm-gateway/LlmGateway` |
| `BASH` | `managed-agents-tool-pi-bash/PiBash` |
| `READ` | `managed-agents-tool-pi-read/PiRead` |
| `EDIT` | `managed-agents-tool-pi-edit/PiEdit` |
| `WRITE` | `managed-agents-tool-pi-write/PiWrite` |
| `SESSION_DIRECTORY` | Existing session-directory D1 database |

The host validates `config.executionGatewayUrl` as an HTTPS origin and
`config.executionToken` against `config.machineId`, then stores them in
resolved immutable session configuration. Session response projections omit the token. The operation
workers continue to own their LLM gateway and image-upload credentials. Public workers.dev and preview URLs are disabled; GET `/health` is the
only HTTP handler. Session commands and completion admission use trusted DO/RPC
bindings through the API and operation workers.

The API route and all five operation-worker callback destination maps include the
new namespace. Minimal-bash remains available in its existing namespace. The
per-machine gateway DO routes results directly to tool callbacks. The host discovers
and pins the machine runtime before its first tool submission; no setup operation
or harness execution callback is needed.

## First deployment

The host and operation workers have reciprocal bindings. Deploy in this order:

1. Bootstrap this host with `wrangler.bootstrap.jsonc` to establish its namespace.
2. Redeploy LLM, bash, read, edit, and write workers with their new namespace bindings
   and `SESSION_ROUTES` entries. Preserve their existing secrets and routes.
3. Deploy this host with `wrangler.jsonc` to activate all five service bindings.
4. Deploy agent-api with the new creation/read route and namespace binding.

Do not admit sessions while the bootstrap configuration is active. Do not use the
bootstrap configuration to update an active deployment. The old execution callback router is not used by these Pi tools. Create fresh sessions for this breaking execution contract and deploy it with the
matching daemon and gateway. Existing session storage is not migrated.

Example session creation body:

```json
{
  "requestId": "pi-session-1",
  "metadata": {},
  "harness": { "id": "pi-no-compaction", "version": "v1" },
  "config": {
    "provider": "fireworks",
    "modelId": "accounts/fireworks/models/glm-5p3-flash",
    "accountId": "<LLM gateway account UUID>",
    "reasoning": "medium",
    "machineId": "<execution gateway machine UUID>",
    "executionGatewayUrl": "https://execution-api.acentric.dev",
    "executionToken": "<machine execution secret for this machine>",
    "cwd": "/absolute/workspace"
  }
}
```

Use the existing backend-authenticated API endpoints for session creation, inputs,
transcript pagination, pending-message pagination and directory listing.

## Verification

```sh
pnpm --filter @managed-agents/app-harness-pi-no-compaction check
```

Includes TypeScript checks, API/Worker RPC tests for both providers, restart tests,
a full production-worker stack with simulated upstreams (including image upload),
and a Wrangler dry build. Tests prohibit unexpected external network access.
Native execution tests also exercise the real gateway and an isolated daemon. Checks do not establish live model quality or availability.

## Immutable execution credentials

The harness requires `config.executionGatewayUrl` (an HTTPS origin) and
`config.executionToken` (a machine-bound `me1.…` secret). Both are immutable.
The host supplies the selected origin as `execution.gatewayUrl`; it is not model input.
The host supplies it as `execution.token` to the Pi tools and pins the discovered
runtime before the first tool dispatch. No credential goes into model inputs,
operation payloads, callback context, transcripts or diagnostics.

There is no top-level creation `execution` field or token-update endpoint/RPC.
Gateway rotation does not modify stored configuration: future submissions with
the old token fail, while already accepted callbacks may still complete. Create
a fresh session with the replacement token. This breaking config contract has
been verified locally; existing sessions are not migrated.
