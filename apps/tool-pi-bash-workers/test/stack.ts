import { readFile } from "node:fs/promises";
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
  id: string; machineId: string; runtimeGenerationId: string; idempotencyKey: string; status: string;
  clientContext: { receiver: string; reference: string };
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
      if (job && JSON.stringify(job.clientContext) !== JSON.stringify(body.clientContext)) return MFResponse.json({ error: { code: "idempotency_conflict" } }, { status: 409 });
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
    return job ? MFResponse.json(job) : MFResponse.json({ error: { code: "not_found" } }, { status: 404 });
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
export async function startStack(gateway = new FakeGateway(), options: { autoQueue?: boolean; persistPath?: string } = {}) {
  const [worker, fixture, callbackWorker, callbackFixture] = await Promise.all([bundle("../src/index.ts"), bundle("./fixture.ts"),
    bundle("../../execution-gateway-callback-workers/src/index.ts"), bundle("../../execution-gateway-callback-workers/test/fixture.ts")]);
  const common = { modules: true, compatibilityDate: "2026-07-30", d1Databases: { BASH_DB: "bash-test-db" },
    bindings: { EXECUTION_GATEWAY_URL: "https://gateway.test", EXECUTION_GATEWAY_API_KEY: "test-key", SESSION_ROUTES: JSON.stringify({ "test-v1": "SESSIONS" }) },
    queueProducers: { COMPLETIONS: "completions" },
    outboundService: (request: MFRequest) => gateway.fetch(request),
  };
  const consumer = { completions: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 } };
  const callbackConsumer = { callbacks: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 } };
  const callbackCommon = { modules: true, compatibilityDate: "2026-07-30", d1Databases: { CALLBACK_DB: "callback-test-db" },
    bindings: { EXECUTION_GATEWAY_WEBHOOK_SECRET: secret, EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET: "previous-secret",
      CALLBACK_ROUTES: JSON.stringify({ "tool-pi-bash-v1": "BASH_EVENTS" }) },
    serviceBindings: { BASH_EVENTS: { name: "bash", entrypoint: "PiBashCallbacks" } }, queueProducers: { DELIVERIES: "callbacks" },
    outboundService: () => { throw new Error("Router must not access the gateway."); },
  };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "bash", script: worker, ...(options.autoQueue === false ? {} : { queueConsumers: consumer }),
      durableObjects: { SESSIONS: { className: "TestSession", scriptName: "host" } } },
    { ...common, name: "host", script: fixture, serviceBindings: { BASH: { name: "bash", entrypoint: "PiBash" }, BASH_EVENTS: { name: "bash", entrypoint: "PiBashCallbacks" } },
      durableObjects: { SESSIONS: { className: "TestSession", useSQLite: true } } },
    { ...callbackCommon, name: "callbacks", script: callbackWorker, ...(options.autoQueue === false ? {} : { queueConsumers: callbackConsumer }) },
    { ...callbackCommon, name: "router-control", script: callbackFixture },
    ...(options.autoQueue === false ? [{ name: "sink", modules: true, script: "export default { queue(batch) { batch.ackAll(); } }", queueConsumers: { ...consumer, ...callbackConsumer } }] : []),
  ], ...(options.persistPath ? { durableObjectsPersist: `${options.persistPath}/objects`, d1Persist: `${options.persistPath}/d1` } : {}) });
  try {
    const db = await app.getD1Database("BASH_DB", "bash");
    if (!await db.prepare("SELECT name FROM sqlite_master WHERE name = 'bash_operations'").first()) {
      for (const sql of (await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8")).split(";").filter(sql => sql.trim())) await db.prepare(sql).run();
    }
    const callbackDb = await app.getD1Database("CALLBACK_DB", "callbacks");
    if (!await callbackDb.prepare("SELECT name FROM sqlite_master WHERE name = 'gateway_callback_events'").first()) {
      for (const sql of (await readFile(new URL("../../execution-gateway-callback-workers/migrations/0001_initial.sql", import.meta.url), "utf8")).split(";").filter(sql => sql.trim())) await callbackDb.prepare(sql).run();
    }
    const host = await app.getWorker("host"), bash = await app.getWorker("bash"), callbacks = await app.getWorker("callbacks"), router = await app.getWorker("router-control");
    return { app, gateway, db, bash, callbacks, callbackDb,
      async call(path: string, body: unknown = {}) {
        const isRouter = path.startsWith("/router/");
        const res = await (isRouter ? router : host).fetch(`https://test${isRouter ? path.slice(7) : path}`, { method: "POST", body: JSON.stringify(body) });
        const value = await res.json() as Record<string, any>;
        if (!res.ok) throw new Error(JSON.stringify(value));
        return value;
      },
    };
  } catch (error) { await app.dispose(); throw error; }
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
export function event(job: FakeJob) { return { schemaVersion: 2, eventId: randomUUID(), type: `job.${job.status}`, jobId: job.id, machineId: job.machineId,
  completedAt: new Date().toISOString(), clientContext: job.clientContext }; }
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
export async function row(stack: Stack, sessionId: string) {
  return until(async () => (await stack.db.prepare("SELECT * FROM bash_operations WHERE session_id = ?").bind(sessionId).first()) || undefined);
}
export async function due(stack: Stack, submissionId: unknown) {
  await stack.db.prepare("UPDATE bash_operations SET next_attempt_at = 0, lease_until = NULL, lease_token = NULL WHERE submission_id = ?").bind(submissionId).run();
}
