import { WorkerEntrypoint } from "cloudflare:workers";
import { WriteService } from "./service.ts";
import type { Env } from "./types.ts";

export class PiWrite extends WorkerEntrypoint<Env> {
  async submit(value: unknown): Promise<unknown> { return { result: await new WriteService(this.env).submit(value) }; }
}
/** Only the execution gateway should bind this private completion entrypoint. */
export class PiWriteCallbacks extends WorkerEntrypoint<Env> {
  async acceptExecutionResult(value: unknown) {
    return new WriteService(this.env).acceptExecutionResult(value);
  }
}
export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
