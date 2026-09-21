# Execution deployment and binary releases

The gateway HTTP API and SQLite `Machine` Durable Object class deploy together as
one Cloudflare Worker. The daemon runs on each registered machine; Cloudflare R2
only hosts its downloadable executables and update manifest. The core is a library
embedded in that executable, not a separate deployment.

## Current Worker deployment

Deployed and verified on **2026-09-21 UTC** (2026-09-22 Asia/Kolkata).

| Worker | Active version |
|---|---|
| `managed-agents-execution-gateway-v1` | `b0a4b8ba-8dbd-4ccb-ad6d-d170b97cad8b` |
| `managed-agents-agent-api` | `a7c6dd99-02cb-44bb-8e6e-4b6b4c017f1d` |
| `managed-agents-harness-minimal-bash-v7` | `3e7517df-1eba-4a79-a69c-43190ff582ef` |
| `managed-agents-harness-pi-no-compaction-v1` | `85888c16-ac8d-4d1c-a19b-df3341975953` |
| `managed-agents-llm-gateway` | `5d7225d8-9c57-4a87-8cbb-444e49600e7d` |
| `managed-agents-tool-pi-bash` | `f63871a3-af30-4877-98a1-40a3c371bf4a` |
| `managed-agents-tool-pi-read` | `a490130f-3310-490a-aa5c-1e355a271559` |
| `managed-agents-tool-pi-edit` | `6909fbe3-e7d7-4a2b-a898-56aa3ad7b847` |
| `managed-agents-tool-pi-write` | `882cb57d-0f85-4f51-a55d-ddcc41810084` |
| `managed-agents-tool-codex-apply-patch` | `1876b261-341c-44f6-a35e-e323d77ea41d` |

Each listed version is deployed at 100%. `execution-api.acentric.dev` now belongs
to the new gateway rather than `managed-agents-execution-gateway-api-v1`.
The new `Machine` namespace is `fd61924f9701425b9627bcae0e5c9062`.
Existing harness namespaces, D1 data and API/LLM/image credentials were preserved.
No D1 migrations were pending. Old Worker resources and unused legacy secrets were
retained; the new tool code does not use static execution API keys.

Verification: full workspace typechecks/tests; public gateway/API/LLM health;
active deployment/binding inspection; real temporary-daemon registration and
retry-safe credentials, WebSocket readiness, callback allowlist rejection,
execution-secret rotation and deletion fencing. The temporary machine was deleted
and its local test state removed. No live model calls or successful production
tool-to-session callbacks were exercised; those paths passed local integration
tests. Codex apply_patch is deployed but still has no production harness route.

The installed daemon was not changed or re-enrolled. The daemon Action has not
been published/run from main and still needs this repository's R2 credentials.
Fresh enrollment and sessions are required for normal use of this breaking stack.

## Previous hosting and the new release feed

The previous repository's `.github/workflows/release-execution-binaries.yml`
publishes to bucket `execution-provider-releases` in account
`62fc73035acad6807728e4385fc03df0`, served by `https://downloads.acentric.dev`.
It publishes archives for `process-execution` and `process-execution-host-daemon`
under `/releases/COMMIT/` and `/latest/`. Its gateway deploys to GCP, not Workers.

The new release workflow reuses the bucket/domain but writes **only** beneath:

```text
managed-agents/process-execution-daemon/
  releases/COMMIT/RUN_ID-RUN_ATTEMPT/
    process-execution-daemon-linux-x86_64
    process-execution-daemon-macos-universal
    process-execution-daemon-windows-x86_64.exe
    manifest.json
    checksums.sha256
    CODEX-LICENSE
    NOTICE
  latest/manifest.json
```

The new updater requires raw executables, not the old compressed archives. One
universal macOS file has manifest entries for both `aarch64` and `x86_64`. Linux
builds use Ubuntu 22.04/glibc 2.35; Linux ARM and Windows ARM are not released.
macOS binaries are ad-hoc signed, not Apple-notarized; Windows binaries are not
Authenticode-signed. Public release hosting must remain trusted.

Every run attempt has a distinct immutable path. Publication verifies downloaded
binary hashes/sizes and the manifest before replacing the single latest manifest.
That manifest points to immutable URLs; there are no mutable latest binary copies.
An older commit may publish an immutable release but cannot promote it once main
has advanced. Configure any custom CDN rules to respect `no-store` on this feed.
The old repository's objects and update feed are never overwritten or deleted.

## Daemon release Action

[Release execution daemon](../.github/workflows/release-execution-daemon.yml) is the
only Action. Matching main pushes or manual runs from main validate, build and
publish the daemon. It never deploys Workers, installs the daemon, restarts services
or registers machines.

The publishing job uses GitHub environment `execution-production`. Configure its
main-branch restriction and optional reviewer approval before the first run.
Add `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the repository or environment,
scoped to the release bucket. Secrets from the old repository are not shared
automatically and cannot be read back through GitHub. Re-enter them from their
credential store or issue new bucket-scoped credentials. No Workers API token or
gateway runtime secrets are needed in GitHub.

The workflow runs full Rust suites on Linux/macOS and portable native/daemon suites
on Windows, then builds all platforms. It provisions Node 24 and Python 3.12 with
IPython 9.8.0 for tests; these are not bundled in the daemon. POSIX-command core/REPL
suites and one POSIX reconnect fixture run only on Unix. All targets are
compiled/linted; generated manifests are validated with the updater's Rust parser.

## Direct Worker deployment

Workers are deployed directly with authenticated Wrangler, not GitHub Actions.
Use the checked-in account, service names, DO migration tags and namespace bindings.
Preserve existing D1 data, session namespaces and secrets.

For the gateway, configure three independent secrets of at least 32 random bytes:

- `MANAGEMENT_SECRET`: enrollment, rotation and deletion.
- `CREDENTIAL_SIGNING_SECRET`: stable retry-safe credential issuance.
- `ROUTING_SIGNING_SECRET`: signed callback routing envelopes.
- Optional `ROUTING_PREVIOUS_SIGNING_SECRET` during rotation, until old outboxes drain.

The production rollout stores these values in the ignored, mode-0600 local file
`.env.execution-gateway.production.json`. Back it up in a trusted credential store.
Do not regenerate keys on each deploy. Wrangler preserves existing secrets not
included in a deployment; removing an old verification key is a separate operation.

From the repository root:

```sh
pnpm typecheck
pnpm test
pnpm --filter @managed-agents/agent-api exec wrangler d1 migrations list SESSION_DIRECTORY --remote

pnpm --filter @managed-agents/app-harness-minimal-bash exec wrangler deploy
pnpm --filter @managed-agents/app-harness-pi-no-compaction exec wrangler deploy
pnpm --filter @managed-agents/llm-gateway-workers exec wrangler deploy
pnpm --filter './apps/tools/*' exec wrangler deploy

pnpm --filter @managed-agents/execution-gateway exec wrangler deploy \
  --secrets-file "$PWD/.env.execution-gateway.production.json"
pnpm --filter @managed-agents/agent-api exec wrangler deploy
```

For an entirely new account, establish harness namespaces using their component
bootstrap configs before deploying reciprocal service bindings. Gateway bootstrap
(`wrangler.bootstrap.jsonc`) creates its Worker/namespace with no public domain
and no callbacks; it is first-deployment-only, never a redeployment config.

Before a breaking cutover, drain/reconcile old work and avoid new submissions.
Deploy matching hosts and tools before moving the execution API domain. The full
gateway config binds all five tool callback entrypoints and takes ownership of
`execution-api.acentric.dev`; confirm the exact previous owner when Wrangler
asks to transfer it. Agent-api deploys last. Do not delete old Worker resources,
namespaces or outboxes as part of this deployment.

Register fresh machine identities and create fresh sessions. Existing machine and
session data is not migrated to the new token-in-config contract. Installing or
re-enrolling a daemon is a separate machine-side step. A successful `/health`
response establishes liveness, not complete execution/callback readiness.

## Installation and updates

Use the immutable artifact URL and corresponding SHA-256 from the new manifest to
download and verify the initial binary; place it in the intended executable path
and make it executable on Unix. Retain the accompanying license/notice. Follow
the [daemon setup](apps/process-execution-daemon/README.md) for enrollment and
user-service installation. Never point the old daemon's updater at this feed.

After the new daemon is installed and the first release exists:

```sh
process-execution-daemon update --manifest-url https://downloads.acentric.dev/managed-agents/process-execution-daemon/latest/manifest.json
```

The updater verifies size, SHA-256 and executable identity before replacing the
binary and restarting an active daemon. Preserve its private state directory.
To select a specific release, supply that release's immutable manifest URL. Roll
back only to a daemon/gateway combination compatible with existing state and
outstanding signed envelopes; do not cross back into the legacy protocol.
