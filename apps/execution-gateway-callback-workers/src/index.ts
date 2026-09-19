import { CallbackService } from "./service.ts";
import { webhook } from "./webhook.ts";
import type { Env, Work } from "./types.ts";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (url.pathname === "/webhooks/execution-gateway" && !url.search) return webhook(request, env, ctx);
    return new Response(null, { status: 404 });
  },
  async queue(batch, env): Promise<void> {
    const service = new CallbackService(env);
    await Promise.all(batch.messages.map(async message => {
      const work = message.body;
      if (!work || typeof work.eventId !== "string" || !work.eventId || work.eventId.length > 100) {
        console.error("Invalid callback queue message."); message.ack(); return;
      }
      try {
        const delay = await service.process(work);
        if (delay === undefined) message.ack(); else message.retry({ delaySeconds: delay });
      } catch { message.retry({ delaySeconds: 30 }); }
    }));
  },
  async scheduled(_event, env): Promise<void> { await new CallbackService(env).recover(); },
} satisfies ExportedHandler<Env, Work>;
