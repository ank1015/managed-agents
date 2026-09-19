import { parseGatewayEventReceipt } from "@managed-agents/contracts";
import type { ExecutionGatewayEvent } from "@managed-agents/contracts";
import { Store, toEvent } from "./store.ts";
import { receiverBinding } from "./types.ts";
import type { Env, Work } from "./types.ts";

export class CallbackService {
  readonly store: Store;
  constructor(readonly env: Env) { this.store = new Store(env.CALLBACK_DB); }
  async admit(event: ExecutionGatewayEvent): Promise<void> {
    await this.store.admit(event);
  }
  async process(work: Work): Promise<number | undefined> {
    const row = await this.store.claim(work.eventId);
    if (!row) return;
    try {
      const binding = receiverBinding(this.env, row.receiver);
      const reply = parseGatewayEventReceipt(JSON.parse(await deliveryDeadline(binding.acceptGatewayEvent(JSON.stringify(toEvent(row))))));
      if (reply.eventId !== row.event_id || reply.jobId !== row.job_id || reply.clientContext.receiver !== row.receiver
        || reply.clientContext.reference !== row.reference) throw new Error("Callback receiver returned a mismatched receipt.");
      await this.store.delivered(row.event_id, row.lease_token!);
    } catch (error) {
      return this.store.retry(row, error instanceof Error ? error.message : "Callback delivery failed.");
    }
  }
  /** Deliver immediately after durable admission; Queue and cron are retry/recovery paths only. */
  async kick(work: Work): Promise<void> {
    try {
      const delay = await this.process(work);
      if (delay !== undefined) await this.enqueue(work, delay);
    } catch {
      await this.enqueue(work);
    }
  }
  async enqueue(work: Work, delaySeconds?: number): Promise<void> {
    // Persist even currently unknown receivers: a deployment fix can recover them without replaying work.
    try { await this.env.DELIVERIES.send(work, delaySeconds === undefined ? undefined : { delaySeconds }); }
    catch { console.error("Callback enqueue failed; scheduled recovery will retry retained events."); }
  }
  async recover(): Promise<void> {
    const work = await this.store.due();
    if (work.length) await this.env.DELIVERIES.sendBatch(work.map(body => ({ body })));
  }
}
/** A timed-out RPC can still finish. Receivers must make repeated event admission safe. */
async function deliveryDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Callback receiver admission timed out.")), 10_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
