import { WorkerEntrypoint } from "cloudflare:workers";
import { ReadService } from "./service.ts";
import type { Env } from "./types.ts";

export class PiRead extends WorkerEntrypoint<Env> {
  async submit(value: unknown): Promise<unknown> { return { result: await new ReadService(this.env).submit(value) }; }
}
/** Only the trusted signature-verifying execution callback router may bind this entrypoint. */
export class PiReadCallbacks extends WorkerEntrypoint<Env> {
  async acceptGatewayEvent(value: unknown): Promise<unknown> {
    return { receipt: await new ReadService(this.env).acceptGatewayEvent(value) };
  }
}
export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
