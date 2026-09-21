import { PI_NO_COMPACTION_IDENTITY } from "@managed-agents/harness-pi-no-compaction";
import type { Env } from "./types.ts";

export { PiNoCompactionSessionV1 } from "./session.ts";

export default {
  async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname !== "/health") return new Response(null, { status: 404 });
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return Response.json({ ok: true, harness: PI_NO_COMPACTION_IDENTITY });
  },
} satisfies ExportedHandler<Env>;
