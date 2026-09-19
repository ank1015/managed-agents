# Managed agents

TypeScript/pnpm monorepo for durable agent sessions on Cloudflare Workers. The implemented path includes the transactional session runtime, authenticated session API, a minimal-bash coding harness using the LLM and Pi-style bash operation workers with durable result delivery.

```sh
pnpm install
pnpm check
```

- [Architecture and implementation status](intended_architecture.md)
- [Cloudflare resources, deployment and activation](DEPLOYMENT.md)
- [Agent API, authentication, local setup and deployment](apps/agent-api/README.md)
- [Session runtime guarantees](packages/session-runtime/README.md)
- [Minimal bash coding harness: configuration, messages, steering and cancellation](apps/harness-minimal-bash/README.md)
- [LLM operation worker, gateway setup and delivery](apps/llm-gateway-workers/README.md)
- [Pi-style bash worker, execution gateway setup and delivery](apps/tool-pi-bash-workers/README.md)
- [Shared execution-gateway callback receiver and tool routing](apps/execution-gateway-callback-workers/README.md)

`pnpm dev` starts only the API (run its bound services separately) after local secrets and D1 migrations are configured as described in the API README. Minimal-bash and the operation workers are tested locally, including the complete callback/Queue path, but require cloud resources, gateway credentials and host bindings before live use. No live provider call or deployment is performed by the checks. Compaction, hard cancellation and streaming remain future work.
