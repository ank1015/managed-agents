import { isDeepStrictEqual } from "node:util";
import type { BashContext } from "../src/context.ts";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import type { Request as MFRequest } from "miniflare";

export const secret = "test-webhook-secret";
export const machineId = "00000000-0000-4000-8000-000000000001";
export const generationId = "00000000-0000-4000-8000-000000000002";
export const input = { machineId, cwd: "/workspace/project", command: "printf 'private command'", timeout: 1.25 };
export interface FakeJob {
  id: string; machineId: string; runtimeGenerationId: string | null; idempotencyKey: string; status: string;
  clientContext: BashContext;
  request: { operation: string; params: { run_id: string; command: { type: string; script: string; shell: { kind: string; executable: string }; login: boolean }; cwd: string; timeout_ms?: number; max_output_bytes: number } };
  response: unknown; error: unknown;
}
export function runResult(runId: string, text = "Hello\n", reason = "exited", exitCode: number | null = 0) {
  const full = Buffer.from(text), preview = full.subarray(-65536);
  return { run_id: runId, execution: {
    handle: { id: "00000000-0000-4000-8000-000000000003", generation_id: generationId }, state: "finished", output_incomplete: false,
    result: reason === "start_failed" || reason === "lost" ? { reason, message: "fixture failure" } : { reason, exit_code: exitCode, signal: null },
  }, output_file: { artifact_id: "00000000-0000-4000-8000-000000000004", path: "/machine/outputs/run.log", size_bytes: full.length,
    sha256: createHash("sha256").update(full).digest("hex"), complete: true, expires_at: { secs_since_epoch: 2_000_000_000, nanos_since_epoch: 123_000_000 } },
  output: [{ stream: "stdout", data_base64: preview.toString("base64") }], output_truncated: full.length > preview.length };
}
export class FakeGateway {
  readonly jobs = new Map<string, FakeJob>();
  posts = 0;
  lookups = 0;
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
      if (job && !isDeepStrictEqual({ machineId: job.machineId, request: job.request, clientContext: job.clientContext }, { machineId: body.machineId, request: body.request, clientContext: body.clientContext })) return MFResponse.json({ error: { code: "idempotency_conflict" } }, { status: 409 });
      if (!job) { job = { id: randomUUID(), ...body, runtimeGenerationId: generationId, status: "waiting_response", response: null, error: null }; this.jobs.set(job.id, job); }
      await this.onAccepted?.(job);
      if (this.loseAcceptance) { this.loseAcceptance--; return new MFResponse("lost response", { status: 502 }); }
      return MFResponse.json({ id: job.id, status: job.status }, { status: 202 });
    }
    if (url.pathname === "/v1/jobs") {
      this.lookups++;
      return MFResponse.json({ data: [...this.jobs.values()].filter(job => job.idempotencyKey === url.searchParams.get("idempotencyKey"))
        .map(({ id, idempotencyKey, status, machineId, runtimeGenerationId }) => ({ id, idempotencyKey, status, machineId, runtimeGenerationId })), nextCursor: null });
    }
    const job = this.jobs.get(url.pathname.slice("/v1/jobs/".length));
    this.details++;
    if (this.detailError) return MFResponse.json({ error: { code: "not_found" } }, { status: this.detailError });
    return job ? MFResponse.json(this.detailValue ? this.detailValue(job) : job) : MFResponse.json({ error: { code: "not_found" } }, { status: 404 });
  }
  finish(job: FakeJob, status = "succeeded", value: unknown = runResult(job.idempotencyKey)) {
    job.status = status;
    job.response = status === "succeeded" ? { protocol_version: 4, request_id: job.id, generation_id: generationId, status: "ok", result: value } : null;
    job.error = status === "failed" ? { code: "dispatch_timeout", message: "Machine did not dispatch" } : status === "unknown" ? { code: "receipt_missing", message: "Lost response" } : null;
  }
}
async function bundle(path: string) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"], write: false });
  return result.outputFiles[0]!.text;
}
export async function startStack(gateway = new FakeGateway(), options: { persistPath?: string } = {}) {
  const [worker, fixture, callbackWorker] = await Promise.all([bundle("../src/index.ts"), bundle("./fixture.ts"),
    bundle("../../execution-gateway-callback-workers/src/index.ts")]);
  const common = { modules: true, compatibilityDate: "2026-07-30",
    bindings: { EXECUTION_GATEWAY_URL: "https://gateway.test", EXECUTION_GATEWAY_API_KEY: "test-key", SESSION_ROUTES: JSON.stringify({ "test-v1": "SESSIONS" }) },
    outboundService: (request: MFRequest) => gateway.fetch(request),
  };
  // No D1 or Queue bindings on either production adapter.
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "bash", script: worker, durableObjects: { SESSIONS: { className: "TestSession", scriptName: "host" } } },
    { ...common, name: "host", script: fixture, serviceBindings: { BASH: { name: "bash", entrypoint: "PiBash" }, BASH_EVENTS: { name: "bash", entrypoint: "PiBashCallbacks" } },
      durableObjects: { SESSIONS: { className: "TestSession", useSQLite: true } } },
    { modules: true, compatibilityDate: "2026-07-30", name: "callbacks", script: callbackWorker,
      bindings: { EXECUTION_GATEWAY_WEBHOOK_SECRET: secret, EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET: "previous-secret",
        CALLBACK_ROUTES: JSON.stringify({ "tool-pi-bash-v1": "BASH_EVENTS" }) },
      serviceBindings: { BASH_EVENTS: { name: "bash", entrypoint: "PiBashCallbacks" } },
      outboundService: () => { throw new Error("Router must not access the gateway."); } },
  ], ...(options.persistPath ? { durableObjectsPersist: `${options.persistPath}/objects` } : {}) });
  try {
    const host = await app.getWorker("host"), bash = await app.getWorker("bash"), callbacks = await app.getWorker("callbacks");
    return { app, gateway, bash, callbacks,
      async call(path: string, body: unknown = {}) {
        const res = await host.fetch(`https://test${path}`, { method: "POST", body: JSON.stringify(body) });
        const value = await res.json() as Record<string, any>;
        if (!res.ok) throw new Error(JSON.stringify(value));
        return value;
      },
    };
  } catch (error) { await app.dispose(); throw error; }
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
export function event(job: FakeJob) { return { schemaVersion: 3, eventId: randomUUID(), type: `job.${job.status}`, jobId: job.id, machineId: job.machineId,
  idempotencyKey: job.idempotencyKey, runtimeGenerationId: job.runtimeGenerationId,
  response: structuredClone(job.response), error: structuredClone(job.error),
  completedAt: new Date().toISOString(), clientContext: structuredClone(job.clientContext) }; }
export function signed(value: ReturnType<typeof event>, key = secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = JSON.stringify(value);
  const signature = createHmac("sha256", key).update(`${timestamp}.${value.eventId}.${body}`).digest("hex");
  return { method: "POST", headers: { "Content-Type": "application/json", "X-Execution-Gateway-Event-Id": value.eventId,
    "X-Execution-Gateway-Timestamp": timestamp, "X-Execution-Gateway-Signature": `v1=${signature}` }, body };
}
export async function until<T>(fn: () => Promise<T>, timeout = 10_000): Promise<Exclude<T, undefined | false | null>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value as Exclude<T, undefined | false | null>; await setTimeout(25); }
  throw new Error("Timed out waiting for test state.");
}
