import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { canonical, jsonValue } from "@managed-agents/execution-gateway-protocol";
import type { CompletionEvent, CompletionReply } from "@managed-agents/execution-gateway-protocol";
interface Env { RECEIPTS: DurableObjectNamespace<ReceiptStore> }
export class ReceiptStore extends DurableObject<Env> {
  private readonly held = new Set<() => void>();
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS receipts (request_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_hash TEXT NOT NULL, event TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS chunks (request_key TEXT NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(request_key, part))");
  }
  async accept(event: CompletionEvent): Promise<CompletionReply> {
    const fail = await this.ctx.storage.get<number>("fail") ?? 0;
    if (fail) { await this.ctx.storage.put("fail", fail - 1); throw Error("Injected pre-admission failure"); }
    const delay = await this.ctx.storage.get<number>("delay") ?? 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (await this.ctx.storage.get<number>("hold")) await new Promise<void>(resolve => this.held.add(resolve));
    const key = canonical(jsonValue([event.machineId, event.runtimeGeneration, event.requestId]));
    const admitted = this.ctx.storage.transactionSync(() => {
      const old = this.ctx.storage.sql.exec<{ request_hash: string; result_hash: string }>("SELECT request_hash, result_hash FROM receipts WHERE request_key = ?", key).toArray()[0];
      if (old && (old.request_hash !== event.requestHash || old.result_hash !== event.resultHash)) return false;
      if (!old) {
        const encoded = JSON.stringify(event);
        this.ctx.storage.sql.exec("INSERT INTO receipts VALUES (?, ?, ?, ?)", key, event.requestHash, event.resultHash, "");
        for (let offset = 0, part = 0; offset < encoded.length; offset += 200_000, part++) {
          this.ctx.storage.sql.exec("INSERT INTO chunks VALUES (?, ?, ?)", key, part, encoded.slice(offset, offset + 200_000));
        }
      }
      return true;
    });
    if (!admitted) return { status: "rejected", code: "COMPLETION_CONFLICT", retryable: false };
    const lose = await this.ctx.storage.get<number>("lose") ?? 0;
    if (lose) { await this.ctx.storage.put("lose", lose - 1); throw Error("Injected lost admission acknowledgement"); }
    const bad = await this.ctx.storage.get<number>("bad") ?? 0;
    if (bad) await this.ctx.storage.put("bad", bad - 1);
    return { status: "accepted", deliveryId: event.deliveryId, requestId: event.requestId, requestHash: event.requestHash, resultHash: bad ? "bad" : event.resultHash };
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/faults") {
      const faults = await request.json() as Record<string, unknown>;
      await this.ctx.storage.put(faults);
      if (faults.hold === 0) { for (const release of this.held) release(); this.held.clear(); }
      return Response.json({ ok: true });
    }
    return Response.json({ held: this.held.size, events: this.ctx.storage.sql.exec<{ request_key: string }>("SELECT request_key FROM receipts ORDER BY rowid").toArray().map(row => JSON.parse(this.ctx.storage.sql.exec<{ content: string }>("SELECT content FROM chunks WHERE request_key = ? ORDER BY part", row.request_key).toArray().map(chunk => chunk.content).join(""))) });
  }
}
export class TestReceiver extends WorkerEntrypoint<Env> {
  async acceptExecutionResult(event: CompletionEvent): Promise<CompletionReply> { return this.env.RECEIPTS.get(this.env.RECEIPTS.idFromName(String((event.callback.context as { sessionId: string }).sessionId))).accept(event); }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), session = url.searchParams.get("session") ?? "session-a";
    return env.RECEIPTS.get(env.RECEIPTS.idFromName(session)).fetch(new Request(`https://receipts${url.pathname}`, request));
  },
};
