import { MINIMAL_BASH_IDENTITY } from "@managed-agents/harness-minimal-bash";
import type { Env } from "./types.ts";

export { MinimalBashSessionV7 } from "./session.ts";

export default {
  async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname !== "/health") return new Response(null, { status: 404 });
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return Response.json({ ok: true, harness: MINIMAL_BASH_IDENTITY });
  },
} satisfies ExportedHandler<Env>;
