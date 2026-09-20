import { WorkerEntrypoint } from "cloudflare:workers";
import { BashService } from "./service.ts";
import type { Env } from "./types.ts";

/** Private submission binding; the public handler cannot submit commands. */
export class PiBash extends WorkerEntrypoint<Env> {
  async submit(value: unknown): Promise<unknown> { return { result: await new BashService(this.env).submit(value) }; }
}
/** Bind only the trusted callback router; this entrypoint cannot submit commands. */
export class PiBashCallbacks extends WorkerEntrypoint<Env> {
  async acceptGatewayEvent(value: unknown): Promise<unknown> {
    return { receipt: await new BashService(this.env).acceptGatewayEvent(value) };
  }
}
export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
