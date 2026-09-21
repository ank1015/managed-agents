import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import type { WebSocket as Socket } from "miniflare";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { hashJson, jsonValue, OPERATIONS, issueMachineSecret, machineSecret } from "@managed-agents/execution-gateway-protocol";
import type { Hello, Json, Outcome, Submission } from "@managed-agents/execution-gateway-protocol";
export const backend = "backend-test-secret-000000000000000000000000";
export const auth = "auth-test-secret-000000000000000000000000000";
export const routingSecret = "routing-test-secret-0000000000000000000000000";
export const generation = "10000000-0000-4000-8000-000000000001";
export const machineId = "10000000-0000-4000-8000-000000000003";
export const defaultCallback = { receiver: "test-v1", context: { sessionId: "session-a" } };
let bundles: Promise<string[]> | undefined;
function scripts() {
  return bundles ??= Promise.all(["../src/index.ts", "./fixture.ts"].map(async path => {
    const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"], write: false });
    return result.outputFiles[0]!.text;
  }));
}
export async function stack(options: { persist?: string; vars?: Record<string, string> } = {}) {
  const [gateway, receiver] = await scripts();
  const common = { modules: true, compatibilityDate: "2026-07-30" };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), ...(options.persist ? { durableObjectsPersist: options.persist } : {}), workers: [
    { ...common, name: "gateway", script: gateway!, bindings: {
      MANAGEMENT_SECRET: backend, CREDENTIAL_SIGNING_SECRET: auth, ROUTING_SIGNING_SECRET: routingSecret,
      ROUTING_PREVIOUS_SIGNING_SECRET: routingSecret + "previous", CALLBACK_ROUTES: JSON.stringify({ "test-v1": "TEST_RECEIVER" }),
      ACCEPT_TIMEOUT_MS: "200", CALLBACK_TIMEOUT_MS: "200", ...options.vars },
      durableObjects: { MACHINES: { className: "Machine", useSQLite: true } },
      serviceBindings: { TEST_RECEIVER: { name: "receiver", entrypoint: "TestReceiver" } } },
    { ...common, name: "receiver", script: receiver!, durableObjects: { RECEIPTS: { className: "ReceiptStore", useSQLite: true } } },
  ] });
  const api = await app.getWorker("gateway"), receipts = await app.getWorker("receiver");
  return { app, api, receipts,
    async request(path: string, method = "GET", body?: unknown, token = backend) {
      return api.fetch(`https://gateway.test${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    async register(id = machineId) {
      const res = await this.request("/v1/machines", "POST", { machineId: id, name: "Test machine" });
      if (!res.ok) throw Error(await res.text());
      return (await res.json() as { daemonSecret: string }).daemonSecret;
    },
    async executionSecret(id = machineId, version = 1) { return issueMachineSecret(auth, id, "execution", version); },
    async connect(token: string, h: Partial<Hello> = {}) {
      const res = await api.fetch(`https://gateway.test/v1/machines/${machineSecret(token, "daemon").machineId}/connect`, { headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" } });
      if (res.status !== 101 || !res.webSocket) throw Error(`${res.status}: ${await res.text()}`);
      const peer = new Peer(res.webSocket); peer.send({ type: "hello", protocolVersion: 1, runtimeGeneration: generation, daemonVersion: "test-1", os: "test", arch: "test", operations: [...OPERATIONS], ...h });
      await peer.next("ready"); return peer;
    },
    async events(session = "session-a") { return (await (await receipts.fetch(`https://receiver/snapshot?session=${session}`)).json() as { events: any[] }).events; },
    async faults(value: Record<string, number>, session = "session-a") { await receipts.fetch(`https://receiver/faults?session=${session}`, { method: "POST", body: JSON.stringify(value) }); },
  };
}
export type Stack = Awaited<ReturnType<typeof stack>>;
export class Peer {
  readonly ws: Socket;
  readonly messages: any[] = [];
  closed = false;
  onRequest: ((value: any) => void | Promise<void>) | undefined;
  constructor(ws: Socket) {
    this.ws = ws;
    ws.accept(); ws.addEventListener("message", event => { if (typeof event.data !== "string" || event.data === "execution:pong") return;
      const value = JSON.parse(event.data); this.messages.push(value); if (value.type === "request") void this.onRequest?.(value); });
    ws.addEventListener("close", () => { this.closed = true; });
  }
  send(value: unknown) { this.ws.send(typeof value === "string" ? value : JSON.stringify(value)); }
  async next(type: string, timeout = 3000): Promise<any> {
    return until(() => { const index = this.messages.findIndex(m => m.type === type); return index < 0 ? undefined : this.messages.splice(index, 1)[0]; }, timeout);
  }
  accept(request: any) { this.send({ type: "accepted", dispatchId: request.dispatchId, requestId: request.requestId, requestHash: request.requestHash, runtimeGeneration: request.runtimeGeneration }); }
  async result(request: any, result: Outcome = { status: "ok", result: { output: "hello" } }) {
    const resultHash = await hashJson(jsonValue(result));
    const frame = { type: "result", deliveryId: await hashJson({ requestHash: request.requestHash, resultHash }), routingEnvelope: request.routingEnvelope, outcome: result };
    this.send(frame); return frame;
  }
}
export function input(requestId = "request-a", changes: Partial<Submission> = {}): Submission {
  return { requestId, runtimeGeneration: generation, operation: { operation: "execution.exec", params: { cwd: "/tmp", env: {}, command: { type: "shell", script: "printf hello" }, completion: { mode: "finished", timeout_ms: 1000 } } }, callback: { receiver: "test-v1", context: { sessionId: "session-a", operationId: requestId } }, ...changes };
}
export async function until<T>(fn: () => T | Promise<T>, timeout = 3000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await setTimeout(10); }
  throw Error("Timed out waiting for fixture state");
}
