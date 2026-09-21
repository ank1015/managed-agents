import { WorkerEntrypoint } from "cloudflare:workers";
import { BashService } from "./service.ts";
import type { Env } from "./types.ts";

export class PiBash extends WorkerEntrypoint<Env> {
  async submit(value: unknown): Promise<unknown> { return { result: await new BashService(this.env).submit(value) }; }
}
/** Only the execution gateway should bind this private completion entrypoint. */
export class PiBashCallbacks extends WorkerEntrypoint<Env> {
  async acceptExecutionResult(value: unknown) {
    return new BashService(this.env).acceptExecutionResult(value);
  }
}
export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
