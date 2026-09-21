import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import type { Request as MFRequest } from "miniflare";
import type { ExecutionGatewayEvent, OperationOutcome, JsonValue } from "@managed-agents/contracts";
import type { WriteContext } from "../src/context.ts";

export const secret = "test-webhook-secret";
export const machineId = "00000000-0000-4000-8000-000000000001";
export const generationId = "00000000-0000-4000-8000-000000000002";
export const input = { machineId, cwd: "/workspace/project", path: "file.txt", content: "Hello\n" };
export interface FakeJob {
  id: string; machineId: string; runtimeGenerationId: string | null; idempotencyKey: string; status: string;
  clientContext: WriteContext;
  request: { operation: string; params: { path: string; cwd: string; mutation_id: string; data_base64: string; create_parent_directories: boolean; mode: string } };
  response: JsonValue; error: JsonValue;
}
export function writeReceipt(job: FakeJob) {
  const p = job.request.params, bytes = Buffer.from(p.data_base64, "base64");
  return { path: p.path.startsWith("/") ? p.path : `${p.cwd}/${p.path}`, mutation_id: p.mutation_id,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes_written: bytes.length, disposition: "applied" };
}
export class FakeGateway {
  readonly jobs = new Map<string, FakeJob>();
  posts = 0;
  details = 0;
  loseAcceptance = 0;
  detailError: number | undefined;
  detailValue: ((job: FakeJob) => unknown) | undefined;
  reject: { code: string; status: number } | undefined;
  onAccepted: ((job: FakeJob) => Promise<void>) | undefined;
  async fetch(request: MFRequest): Promise<MFResponse> {
    if (new URL(request.url).origin !== "https://gateway.test" || request.headers.get("Authorization") !== "Bearer test-key") throw new Error("Unexpected gateway request.");
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      this.posts++;
      const body = await request.json() as Pick<FakeJob, "machineId" | "idempotencyKey" | "request" | "clientContext">;
      if (this.reject) return MFResponse.json({ error: { code: this.reject.code, message: "secret upstream error" } }, { status: this.reject.status });
      let job = [...this.jobs.values()].find(job => job.idempotencyKey === body.idempotencyKey);
      if (job && !isDeepStrictEqual({ machineId: job.machineId, idempotencyKey: job.idempotencyKey, request: job.request, clientContext: job.clientContext }, body)) return MFResponse.json({ error: { code: "idempotency_conflict" } }, { status: 409 });
      if (!job) { job = { id: randomUUID(), ...body, runtimeGenerationId: generationId, status: "waiting_response", response: null, error: null }; this.jobs.set(job.id, job); }
      await this.onAccepted?.(job);
      if (this.loseAcceptance) { this.loseAcceptance--; return new MFResponse("lost response", { status: 502 }); }
      return MFResponse.json({ id: job.id, status: job.status }, { status: 202 });
    }
    if (!url.pathname.startsWith("/v1/jobs/")) throw new Error("Unexpected gateway lookup.");
    this.details++;
    if (this.detailError) return MFResponse.json({ error: { code: "not_found" } }, { status: this.detailError });
    const job = this.jobs.get(url.pathname.slice("/v1/jobs/".length));
    if (!job) return MFResponse.json({ error: { code: "not_found" } }, { status: 404 });
    // Job detail includes the retained request, including base64 write bytes.
    return MFResponse.json(this.detailValue ? this.detailValue(job) : { ...job, requestStatus: "retained" });
  }
  finish(job: FakeJob, value: JsonValue = writeReceipt(job)) {
    job.status = "succeeded"; job.error = null;
    job.response = { protocol_version: 4, request_id: job.id, generation_id: generationId, status: "ok", result: value };
  }
  fileError(job: FakeJob, code: string, message: string) {
    job.status = "failed"; job.error = null;
    job.response = { protocol_version: 4, request_id: job.id, generation_id: generationId, status: "error", error: { code, message } };
  }
}
export type Snapshot = { admittedCompletions: number; results: { event_id: string; payload: string }[];
  operations: { operationId: string; submissionId: string; jobId: string; outcome: OperationOutcome | null }[];
  progress: { blocked: boolean }; outbox: unknown[] };
async function bundle(path: string) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:buffer"], write: false });
  return result.outputFiles[0]!.text;
}
export async function startStack(gateway = new FakeGateway(), options: { persistPath?: string } = {}) {
  const [worker, fixture, callbackWorker] = await Promise.all([bundle("../src/index.ts"), bundle("./fixture.ts"), bundle("../../execution-gateway-callback-workers/src/index.ts")]);
  const common = { modules: true, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
    bindings: { EXECUTION_GATEWAY_URL: "https://gateway.test", EXECUTION_GATEWAY_API_KEY: "test-key", SESSION_ROUTES: JSON.stringify({ "test-v1": "SESSIONS" }) },
    outboundService: (request: MFRequest) => gateway.fetch(request),
  };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "write", script: worker, durableObjects: { SESSIONS: { className: "TestSession", scriptName: "host" } } },
    { ...common, name: "host", script: fixture, serviceBindings: { WRITE: { name: "write", entrypoint: "PiWrite" }, WRITE_EVENTS: { name: "write", entrypoint: "PiWriteCallbacks" } },
      durableObjects: { SESSIONS: { className: "TestSession", useSQLite: true } } },
    { modules: true, compatibilityDate: "2026-07-30", name: "callbacks", script: callbackWorker,
      bindings: { EXECUTION_GATEWAY_WEBHOOK_SECRET: secret, CALLBACK_ROUTES: JSON.stringify({ "tool-pi-write-v1": "WRITE_EVENTS" }) },
      serviceBindings: { WRITE_EVENTS: { name: "write", entrypoint: "PiWriteCallbacks" } },
      outboundService: () => { throw new Error("Router must not access the gateway or image API."); } },
  ], ...(options.persistPath ? { durableObjectsPersist: `${options.persistPath}/objects` } : {}) });
  try {
    const host = await app.getWorker("host"), write = await app.getWorker("write"), callbacks = await app.getWorker("callbacks");
    return { app, gateway, write, callbacks,
      async call<T = Snapshot>(path: string, body: unknown = {}): Promise<T> {
        const res = await host.fetch(`https://test${path}`, { method: "POST", body: JSON.stringify(body) });
        const value: unknown = await res.json();
        if (!res.ok) throw new Error(JSON.stringify(value));
        return value as T;
      },
    };
  } catch (error) { await app.dispose(); throw error; }
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
export function event(job: FakeJob): ExecutionGatewayEvent {
  return { schemaVersion: 3, eventId: randomUUID(), jobId: job.id, machineId: job.machineId, idempotencyKey: job.idempotencyKey,
    runtimeGenerationId: job.runtimeGenerationId, type: `job.${job.status}` as ExecutionGatewayEvent["type"], completedAt: "2026-09-21T00:00:00Z",
    clientContext: job.clientContext, response: job.response, error: job.error };
}
export function signed(value: unknown, key = secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = JSON.stringify(value), eventId = (value as { eventId: string }).eventId;
  const signature = createHmac("sha256", key).update(`${timestamp}.${eventId}.${body}`).digest("hex");
  return { method: "POST", body, headers: { "content-type": "application/json", "x-execution-gateway-timestamp": timestamp,
    "x-execution-gateway-event-id": eventId, "x-execution-gateway-signature": `v1=${signature}` } };
}
export async function until<T>(get: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 150; i++) { const result = await get(); if (result !== undefined) return result; await setTimeout(20); }
  throw new Error("Condition did not become true.");
}
