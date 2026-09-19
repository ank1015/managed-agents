import { WorkerEntrypoint } from "cloudflare:workers";
import { BashService } from "./service.ts";
import type { Env, Work } from "./types.ts";

/** Private service-binding entrypoint. The public fetch handler exposes no submission API. */
export class PiBash extends WorkerEntrypoint<Env> {
  async submit(serialized: string): Promise<string> {
    return JSON.stringify(await new BashService(this.env).submit(JSON.parse(serialized)));
  }
  async get(serialized: string): Promise<string> {
    return JSON.stringify(await new BashService(this.env).get(JSON.parse(serialized)));
  }
}
/** Bind only trusted callback routers here; this entrypoint cannot submit commands. */
export class PiBashCallbacks extends WorkerEntrypoint<Env> {
  async acceptGatewayEvent(serialized: string): Promise<string> {
    const service = new BashService(this.env);
    const admitted = await service.admitGatewayEvent(JSON.parse(serialized));
    if (admitted.deferToQueue) this.ctx.waitUntil(service.enqueue(admitted.work));
    else this.ctx.waitUntil(service.kick(admitted.work));
    return JSON.stringify(admitted.receipt);
  }
}
export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  },
  async queue(batch, env): Promise<void> {
    const service = new BashService(env);
    await Promise.all(batch.messages.map(async message => {
      const value = message.body;
      if (!value || value.kind !== "operation" || typeof value.id !== "string" || !value.id || value.id.length > 2048) {
        console.error("Invalid BASH queue message."); message.ack(); return;
      }
      try {
        const delay = await service.process(value);
        if (delay === undefined) message.ack(); else message.retry({ delaySeconds: delay });
      } catch { message.retry({ delaySeconds: 30 }); }
    }));
  },
  async scheduled(_event, env): Promise<void> { await new BashService(env).recover(); },
} satisfies ExportedHandler<Env, Work>;
