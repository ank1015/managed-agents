# Managed agents

Monorepo for durable coding-agent sessions on Cloudflare Workers, with a native
execution daemon and core.

Two harnesses are implemented: **minimal-bash/v7** (OpenAI and serial bash) and
**pi-no-compaction/v1** (OpenAI or Fireworks, with read, bash, edit and write).
Both store immutable session configuration, including a machine execution secret.
Codex-style apply_patch is available as a separate tool Worker, not yet exposed by
either harness.

The session runtime plans transitions read-only, submits operations with stable
identities, then atomically commits harness changes and acceptance receipts.
Outgoing requests are not persisted. A D1 directory routes sessions to their
harness-specific SQLite Durable Objects.

The execution gateway validates separate daemon and execution secrets and routes
requests through one hibernating Durable Object per machine. The daemon's durable
outbox owns result delivery retries. Tool Workers receive results over private
service bindings and acknowledge only after durable session admission. LLM
operations use their separate gateway and signed HTTP callback contract.

## Development

```sh
pnpm install
pnpm check
cargo test --manifest-path execution/Cargo.toml --workspace
```

Checks include local Worker/SQLite integration tests, isolated native daemons and
dry-run Worker builds. They do not deploy or invoke live model providers.
`pnpm dev` starts only agent-api; its bound services and local resources must be
configured separately.

## Documentation

- [Agent API and authentication](apps/agent-api/README.md)
- [Session runtime](packages/session-runtime/README.md)
- [Harness API](packages/harness-api/README.md)
- [Contracts](packages/contracts/README.md)
- [Minimal bash host and setup](apps/harness-minimal-bash/README.md)
- [Pi no-compaction host and setup](apps/harness-pi-no-compaction/README.md)
- [Session execution integration and rollout](packages/session-execution/README.md)
- [LLM operation Worker](apps/llm-gateway-workers/README.md)
- [Tool Workers](apps/tools/README.md)
- [Execution subsystem](execution/README.md)
- [Execution gateway](execution/apps/execution-gateway/README.md)
- [Native daemon and CLI](execution/apps/process-execution-daemon/README.md)
- [Native execution core](execution/packages/process-execution-core/README.md)
- [Execution transport protocol](execution/packages/execution-gateway-protocol/README.md)
- [Logging policy](packages/diagnostics/README.md)

The machine-secret integration is a breaking source update, locally verified but
not deployed. Follow the component setup and rollout instructions together; use
fresh machine enrollment and sessions. Builds do not modify cloud resources or
the installed daemon. Compaction, hard cancellation and streaming remain future
work.
