# Execution

The execution subsystem is split by responsibility, not by user/account ownership:

- [Execution gateway](apps/execution-gateway/README.md): one Cloudflare Worker with
  the HTTP API and one hibernating `Machine` Durable Object per machine. It validates
  machine secrets, routes operations and forwards results to private service bindings.
- [Process execution daemon](apps/process-execution-daemon/README.md): outbound
  machine connection, durable request admission and result outbox. It embeds the core.
- [Process execution core](packages/process-execution-core/README.md): native
  process, filesystem and REPL operations; no gateway authentication or callback routing.
- [Gateway protocol](packages/execution-gateway-protocol/README.md): shared
  TypeScript transport schemas, validation, hashing and routing-envelope signing.

The Worker and TypeScript package belong to the repository's pnpm workspace.
The daemon and core belong to the Cargo workspace rooted here.

## Verification

```sh
pnpm --filter @managed-agents/execution-gateway-protocol check
pnpm --filter @managed-agents/execution-gateway check
cargo test --manifest-path execution/Cargo.toml --workspace
```

## Cutover

This is a breaking machine-secret contract, not an in-place migration of the old
user registry. Deploy matching gateway, daemon, Pi tool receivers and session hosts;
use fresh machine enrollment and sessions. The gateway requires separate management,
credential-issuance and routing-signing secrets. Keep existing outboxes recoverable
until their work is drained or explicitly reconciled. Do not switch an old daemon
state directory to a new gateway identity.

Source changes and dry-run builds do not deploy Workers, remove old namespaces,
install login services or replace the currently installed daemon.
