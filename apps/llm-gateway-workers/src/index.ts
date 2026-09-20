import { WorkerEntrypoint } from "cloudflare:workers";
import { LlmService } from "./service.ts";
import type { Env } from "./types.ts";
import { webhook } from "./webhook.ts";

/** Private submission only. The gateway durably owns jobs and delivery retries. */
export class LlmGateway extends WorkerEntrypoint<Env> {
  async submit(value: unknown): Promise<unknown> {
    return { result: await new LlmService(this.env).submit(value) };
  }
}
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (url.pathname === "/webhooks/llm-gateway" && !url.search) return webhook(request, env);
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
