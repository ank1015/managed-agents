import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";

export const secret = "test-webhook-secret";
export const url = "https://callbacks.test/webhooks/execution-gateway";
export const routes = { "tool-pi-bash-v1": "BASH_EVENTS", "tool-patch-v1": "PATCH_EVENTS" };
export function event(receiver = "tool-pi-bash-v1") {
  return { schemaVersion: 2, eventId: randomUUID(), jobId: randomUUID(), machineId: randomUUID(),
    type: "job.succeeded", completedAt: new Date().toISOString(), clientContext: { receiver, reference: randomUUID() } };
}
export function signed(value: unknown, key = secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = JSON.stringify(value), eventId = (value as { eventId: string }).eventId;
  const signature = createHmac("sha256", key).update(`${timestamp}.${eventId}.${body}`).digest("hex");
  return { method: "POST", headers: { "Content-Type": "application/json", "X-Execution-Gateway-Event-Id": eventId,
    "X-Execution-Gateway-Timestamp": timestamp, "X-Execution-Gateway-Signature": `v1=${signature}` }, body };
}
async function bundle(path: string) {
  const output = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"], write: false });
  return output.outputFiles[0]!.text;
}
export async function startStack(options: { autoQueue?: boolean; persistPath?: string; routes?: Record<string, string>; queueFails?: boolean } = {}) {
  const [worker, fixture] = await Promise.all([bundle("../src/index.ts"), bundle("./fixture.ts")]);
  const consumer = { callbacks: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 } };
  const common = { modules: true, compatibilityDate: "2026-07-30", d1Databases: { CALLBACK_DB: "callback-test-db" },
    bindings: { EXECUTION_GATEWAY_WEBHOOK_SECRET: secret, EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET: "previous-secret",
      CALLBACK_ROUTES: JSON.stringify(options.routes ?? routes) },
    ...(options.queueFails ? {} : { queueProducers: { DELIVERIES: "callbacks" } }),
    serviceBindings: { BASH_EVENTS: { name: "bash-receiver", entrypoint: "TestReceiver" }, PATCH_EVENTS: { name: "patch-receiver", entrypoint: "TestReceiver" } },
    outboundService: () => { throw new Error("Callback worker must not make gateway/network requests."); },
  };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "callbacks", script: worker, ...(options.autoQueue === false ? {} : { queueConsumers: consumer }) },
    { ...common, name: "control", script: fixture, durableObjects: { STATES: { className: "ReceiverState", useSQLite: true } } },
    ...["bash", "patch"].map(tool => ({ modules: true, compatibilityDate: "2026-07-30", name: `${tool}-receiver`, script: fixture,
      bindings: { RECEIVER_NAME: tool === "bash" ? "tool-pi-bash-v1" : "tool-patch-v1" },
      durableObjects: { STATES: { className: "ReceiverState", scriptName: "control" } } })),
    ...(options.autoQueue === false ? [{ name: "sink", modules: true, script: "export default { queue(batch) { batch.ackAll(); } }", queueConsumers: consumer }] : []),
  ], ...(options.persistPath ? { durableObjectsPersist: `${options.persistPath}/objects`, d1Persist: `${options.persistPath}/d1` } : {}) });
  try {
    const db = await app.getD1Database("CALLBACK_DB", "callbacks");
    if (!await db.prepare("SELECT name FROM sqlite_master WHERE name = 'gateway_callback_events'").first()) {
      for (const sql of (await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8")).split(";").filter(sql => sql.trim())) await db.prepare(sql).run();
    }
    const callback = await app.getWorker("callbacks"), control = await app.getWorker("control");
    return { app, db, callback, async call(path: string, body: unknown = {}) {
      const res = await control.fetch(`https://test${path}`, { method: "POST", body: JSON.stringify(body) });
      const value = await res.json() as { delay?: number | null; events?: unknown[] };
      if (!res.ok) throw new Error(JSON.stringify(value));
      return value;
    } };
  } catch (error) { await app.dispose(); throw error; }
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
export async function until<T>(fn: () => Promise<T>): Promise<T> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await setTimeout(25); }
  throw new Error("Timed out waiting for callback state.");
}
export async function row(stack: Stack, id: string) { return stack.db.prepare("SELECT * FROM gateway_callback_events WHERE event_id = ?").bind(id).first(); }
export async function process(stack: Stack, eventId: string) {
  await stack.db.prepare("UPDATE gateway_callback_events SET next_attempt_at = 0 WHERE event_id = ?").bind(eventId).run();
  return (await stack.call("/process", { eventId })).delay;
}
