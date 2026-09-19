import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { parseExecutionGatewayEvent } from "@managed-agents/contracts";
import { CallbackService } from "../src/service.ts";
import handler from "../src/index.ts";
import type { Env } from "../src/types.ts";

interface TestEnv extends Env { STATES: DurableObjectNamespace<ReceiverState>; RECEIVER_NAME: string }
type Faults = { fail?: number; lose?: number; bad?: number };
export class ReceiverState extends DurableObject<TestEnv> {
  async admit(serialized: string): Promise<string> {
    const event = parseExecutionGatewayEvent(JSON.parse(serialized));
    const faults = await this.ctx.storage.get<Faults>("faults") ?? {};
    if (faults.fail) { await this.ctx.storage.put("faults", { ...faults, fail: faults.fail - 1 }); throw new Error("Injected receiver outage."); }
    const key = `event:${event.eventId}`;
    const previous = await this.ctx.storage.get<string>(key);
    if (previous && previous !== serialized) throw new Error("Conflicting event.");
    await this.ctx.storage.put(key, serialized);
    if (faults.lose) { await this.ctx.storage.put("faults", { ...faults, lose: faults.lose - 1 }); throw new Error("Injected lost receiver receipt."); }
    return JSON.stringify({ status: "accepted", eventId: faults.bad ? crypto.randomUUID() : event.eventId,
      jobId: event.jobId, clientContext: event.clientContext });
  }
  async faults(value: Faults) { await this.ctx.storage.put("faults", value); }
  async events(): Promise<string> { return JSON.stringify([...(await this.ctx.storage.list<string>({ prefix: "event:" })).values()].map(value => JSON.parse(value))); }
}
export class TestReceiver extends WorkerEntrypoint<TestEnv> {
  async acceptGatewayEvent(serialized: string): Promise<string> {
    const event = parseExecutionGatewayEvent(JSON.parse(serialized));
    if (event.clientContext.receiver !== this.env.RECEIVER_NAME) throw new Error("Router sent event to the wrong binding.");
    return this.env.STATES.get(this.env.STATES.idFromName(this.env.RECEIVER_NAME)).admit(serialized);
  }
}
export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      const body = await request.json() as Faults & { eventId: string; receiver: string };
      if (path === "/process") return Response.json({ delay: await new CallbackService(env).process(body) ?? null });
      if (path === "/recover") { await handler.scheduled({} as ScheduledController, env); return Response.json({ ok: true }); }
      const state = env.STATES.get(env.STATES.idFromName(body.receiver));
      if (path === "/faults") { await state.faults(body); return Response.json({ ok: true }); }
      if (path === "/events") return Response.json({ events: JSON.parse(await state.events()) });
      return new Response(null, { status: 404 });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
} satisfies ExportedHandler<TestEnv>;
