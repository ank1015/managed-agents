import { webhook } from "./webhook.ts";
import type { Env } from "./types.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (url.pathname === "/webhooks/execution-gateway" && !url.search) return webhook(request, env);
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
