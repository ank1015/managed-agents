# Pi no-compaction Worker host

Hosts [`pi-no-compaction/v1`](../../packages/harness-pi-no-compaction/README.md) in a
fresh SQLite Durable Object class, `PiNoCompactionSessionV1`. Worker name:
`managed-agents-harness-pi-no-compaction-v1`; route key: `pi-no-compaction-v1`.

Deployed and tested on 2026-09-21: two OpenAI runs and two Fireworks runs passed
76 checks on the production Mac. See the [production test record](../../PI_NO_COMPACTION_PRODUCTION_TEST.md)
for model coverage, callback retry observations and deployment versions.

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

The host needs no provider credentials. The operation workers own their existing
credentials. Public workers.dev and preview URLs are disabled; GET `/health` is the
only HTTP handler. Session commands and completion admission use trusted DO/RPC
bindings through the API and operation workers.

The API route and all five operation-worker callback destination maps include the
new namespace. Minimal-bash remains available in its existing namespace. The
execution callback router already supports all four receiver IDs; no changes are
needed there.

## First deployment

The host and operation workers have reciprocal bindings. Deploy in this order:

1. Bootstrap this host with `wrangler.bootstrap.jsonc` to establish its namespace.
2. Redeploy LLM, bash, read, edit, and write workers with their new namespace bindings
   and `SESSION_ROUTES` entries. Preserve their existing secrets and routes.
3. Deploy this host with `wrangler.jsonc` to activate all five service bindings.
4. Deploy agent-api with the new creation/read route and namespace binding.

Do not admit sessions while the bootstrap configuration is active. Do not use the
bootstrap configuration to update an active deployment. The existing execution
callback router remains suitable. No existing DO namespace or D1 migration changes.

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
Live image interpretation passed for OpenAI Sol, Fireworks GLM 5.3 Flash and
DeepSeek V4.1 Flash. The production record identifies the tested reasoning tiers;
other model/tier combinations are not established by those runs. No Fireworks
image conversion was changed in this implementation.
