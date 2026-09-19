import { WorkerEntrypoint } from "cloudflare:workers";
import { LlmService } from "./service.ts";
import type { Env, Work } from "./types.ts";
import { webhook } from "./webhook.ts";

/** Private service-binding entrypoint. The public fetch handler exposes no submission API. */
export class LlmGateway extends WorkerEntrypoint<Env> {
  async submit(serialized: string): Promise<string> {
    return JSON.stringify(await new LlmService(this.env).submit(JSON.parse(serialized)));
  }
  async get(serialized: string): Promise<string> {
    return JSON.stringify(await new LlmService(this.env).get(JSON.parse(serialized)));
  }
}
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (url.pathname === "/webhooks/llm-gateway" && !url.search) return webhook(request, env, ctx);
    return new Response(null, { status: 404 });
  },
  async queue(batch, env): Promise<void> {
    const service = new LlmService(env);
    await Promise.all(batch.messages.map(async message => {
      const value = message.body;
      if (!value || !["operation", "event"].includes(value.kind) || typeof value.id !== "string" || !value.id || value.id.length > 2048) {
        console.error("Invalid LLM queue message."); message.ack(); return;
      }
      try {
        const delay = await service.process(value);
        if (delay === undefined) message.ack(); else message.retry({ delaySeconds: delay });
      } catch { message.retry({ delaySeconds: 30 }); }
    }));
  },
  async scheduled(_event, env): Promise<void> { await new LlmService(env).recover(); },
} satisfies ExportedHandler<Env, Work>;
