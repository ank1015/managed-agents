# Managed agents

TypeScript/pnpm monorepo for durable coding-agent sessions on Cloudflare Workers.

The current harness is **`minimal-bash/v7`**: OpenAI model calls, serial Pi-style bash execution, persistent conversation history, batched steering and graceful turn-boundary cancellation.

The session runtime plans transitions read-only, submits operations with stable identities, then atomically commits harness changes and acceptance receipts. Outgoing requests are not persisted. Stateless operation workers forward signed inline gateway callbacks to the session; gateway retries own accepted-job delivery. The active stack uses a D1 session directory and Durable Object SQLite, with no adapter databases, Queues or crons.

```sh
pnpm install
pnpm check
```

## Documentation

- [Architecture and design decisions](intended_architecture.md)
- [Cloudflare deployment and configuration](DEPLOYMENT.md)
- [Latest production cost and latency benchmark](V7_PRODUCTION_BENCHMARK.md)
- [Agent API and authentication](apps/agent-api/README.md)
- [Session runtime](packages/session-runtime/README.md)
- [Harness API](packages/harness-api/README.md)
- [Minimal bash harness and rollout](apps/harness-minimal-bash/README.md)
- [LLM operation worker](apps/llm-gateway-workers/README.md)
- [Pi-style bash operation worker](apps/tool-pi-bash-workers/README.md)
- [Execution callback router](apps/execution-gateway-callback-workers/README.md)
- [Logging policy](packages/diagnostics/README.md)

`pnpm dev` starts only the API; run its bound services separately after configuring local secrets and D1. Checks use fake gateways and do not deploy or invoke real providers. Compaction, hard cancellation, additional tools and streaming remain future work.
