import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import type { Request as MFRequest } from "miniflare";

export const secret = "test-webhook-secret";
export const accountId = "00000000-0000-4000-8000-000000000001";
export const input = { accountId, modelId: "test-model", messages: [{ role: "user", content: [{ type: "text", text: "private prompt" }] }] };
export const response = { id: "response-1", modelId: "test-model", message: { role: "assistant", provider: "openai",
  content: [{ type: "message", id: "native-id", content: [{ type: "output_text", text: "Hello" }] }, { type: "reasoning", encrypted_content: "opaque" }] },
  stopReason: "stop", usage: { input: 10, output: 2 }, durationMs: 42, timestamp: 1234 };
export interface FakeJob { id: string; idempotencyKey: string; status: string; request: unknown; response: unknown; error: unknown }
export class FakeGateway {
  readonly jobs = new Map<string, FakeJob>();
  posts = 0;
  details = 0;
  loseAcceptance = 0;
  reject: { code: string; status: number } | undefined;
  onAccepted: ((job: FakeJob) => Promise<void>) | undefined;
  async fetch(request: MFRequest): Promise<MFResponse> {
    if (new URL(request.url).origin !== "https://gateway.test" || request.headers.get("Authorization") !== "Bearer test-key") throw new Error("Unexpected gateway request.");
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      this.posts++;
      const body = await request.json() as { idempotencyKey: string };
      if (this.reject) return MFResponse.json({ error: { code: this.reject.code, message: "secret upstream error" } }, { status: this.reject.status });
      let job = [...this.jobs.values()].find(job => job.idempotencyKey === body.idempotencyKey);
      if (!job) { job = { id: randomUUID(), idempotencyKey: body.idempotencyKey, status: "queued", request: body, response: null, error: null }; this.jobs.set(job.id, job); }
      await this.onAccepted?.(job);
      if (this.loseAcceptance) { this.loseAcceptance--; return new MFResponse("lost response", { status: 502 }); }
      return MFResponse.json({ id: job.id, status: job.status }, { status: 202 });
    }
    if (url.pathname === "/v1/jobs") return MFResponse.json({ data: [...this.jobs.values()].filter(job => job.idempotencyKey === url.searchParams.get("idempotencyKey"))
      .map(({ id, idempotencyKey, status }) => ({ id, idempotencyKey, status })), nextCursor: null });
    const job = this.jobs.get(url.pathname.slice("/v1/jobs/".length));
    this.details++;
    return job ? MFResponse.json(job) : MFResponse.json({ error: { code: "not_found" } }, { status: 404 });
  }
  finish(job: FakeJob, status = "succeeded", value: unknown = response) {
    job.status = status; job.response = status === "succeeded" ? value : null;
    job.error = status === "failed" ? { code: "model_error", message: "Model failed", retryable: false } : null;
  }
}
async function bundle(path: string) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"], write: false });
  return result.outputFiles[0]!.text;
}
export async function startStack(gateway = new FakeGateway(), options: { autoQueue?: boolean; persistPath?: string } = {}) {
  const [worker, fixture] = await Promise.all([bundle("../src/index.ts"), bundle("./fixture.ts")]);
  const common = { modules: true, compatibilityDate: "2026-07-30", d1Databases: { LLM_DB: "llm-test-db" },
    bindings: { GATEWAY_URL: "https://gateway.test", GATEWAY_API_KEY: "test-key", GATEWAY_WEBHOOK_SECRET: secret,
      GATEWAY_PREVIOUS_WEBHOOK_SECRET: "previous-secret", SESSION_ROUTES: JSON.stringify({ "test-v1": "SESSIONS" }) },
    queueProducers: { COMPLETIONS: "completions" },
    outboundService: (request: MFRequest) => gateway.fetch(request),
  };
  const consumer = { completions: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 } };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "llm", script: worker, ...(options.autoQueue === false ? {} : { queueConsumers: consumer }),
      durableObjects: { SESSIONS: { className: "TestSession", scriptName: "host" } } },
    { ...common, name: "host", script: fixture, serviceBindings: { LLM: { name: "llm", entrypoint: "LlmGateway" } },
      durableObjects: { SESSIONS: { className: "TestSession", useSQLite: true } } },
    ...(options.autoQueue === false ? [{ name: "sink", modules: true, script: "export default { queue(batch) { batch.ackAll(); } }", queueConsumers: consumer }] : []),
  ], ...(options.persistPath ? { durableObjectsPersist: `${options.persistPath}/objects`, d1Persist: `${options.persistPath}/d1` } : {}) });
  try {
    const db = await app.getD1Database("LLM_DB", "llm");
    if (!await db.prepare("SELECT name FROM sqlite_master WHERE name = 'llm_operations'").first()) {
      for (const sql of (await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8")).split(";").filter(sql => sql.trim())) await db.prepare(sql).run();
    }
    const host = await app.getWorker("host"), llm = await app.getWorker("llm");
    return { app, gateway, db, llm,
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
export function event(job: FakeJob) { return { eventId: randomUUID(), type: `job.${job.status}`, jobId: job.id, completedAt: new Date().toISOString() }; }
export function signed(value: ReturnType<typeof event>, key = secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = JSON.stringify(value);
  const signature = createHmac("sha256", key).update(`${timestamp}.${value.eventId}.${body}`).digest("hex");
  return { method: "POST", headers: { "Content-Type": "application/json", "X-LLM-Gateway-Event-Id": value.eventId,
    "X-LLM-Gateway-Timestamp": timestamp, "X-LLM-Gateway-Signature": `v1=${signature}` }, body };
}
export async function until<T>(fn: () => Promise<T>, timeout = 10_000): Promise<Exclude<T, undefined | false | null>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value as Exclude<T, undefined | false | null>; await setTimeout(25); }
  throw new Error("Timed out waiting for test state.");
}
export async function row(stack: Stack, sessionId: string) {
  return until(async () => (await stack.db.prepare("SELECT * FROM llm_operations WHERE session_id = ?").bind(sessionId).first()) || undefined);
}
export async function due(stack: Stack, submissionId: unknown) {
  await stack.db.prepare("UPDATE llm_operations SET next_attempt_at = 0, lease_until = NULL, lease_token = NULL WHERE submission_id = ?").bind(submissionId).run();
}
