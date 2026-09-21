# Tool Workers

Independently deployed, stateless operation Workers, grouped in this directory:

- [Pi bash](tool-pi-bash-workers/README.md): `execution.exec`.
- [Pi read](tool-pi-read-workers/README.md): `filesystem.read`.
- [Pi write](tool-pi-write-workers/README.md): `filesystem.write`.
- [Pi edit](tool-pi-edit-workers/README.md): `filesystem.patch` with text replacements.
- [Codex apply_patch](tool-codex-apply-patch-workers/README.md): `filesystem.patch` with raw Codex patch text.

All use the [machine-only execution gateway](../../execution/apps/execution-gateway/README.md).
Harness hosts supply `{ destination, execution: { token, runtimeGeneration }, submission }`
via private RPC. Tokens never belong in model-facing tool arguments.
Results return through private `acceptExecutionResult` entrypoints and durable Session
DO admission. The daemon owns delivery retries; there is no legacy jobs API or webhook
fallback in these Workers.

Package names and Cloudflare Worker names are unchanged by this directory move.
Run all tool checks with `pnpm --filter './apps/tools/*' check`.
