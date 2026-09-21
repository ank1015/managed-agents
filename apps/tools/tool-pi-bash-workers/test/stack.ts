import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import type { Request as MFRequest } from "miniflare";
import { hashJson, jsonValue, issueMachineSecret, machineSecret, object } from "@managed-agents/execution-gateway-protocol";
import type { CompletionEvent, Outcome, Submission } from "@managed-agents/execution-gateway-protocol";
import type { OperationOutcome, ToolExecutionContext } from "@managed-agents/contracts";
export const auth = "bash-test-signing-secret-at-least-32-bytes";
export const machineId = "00000000-0000-4000-8000-000000000001";
export const generationId = "00000000-0000-4000-8000-000000000002";
export const input = { machineId, cwd: "/workspace/project", command: "printf hello", timeout: 1.25 };
export async function execution(sessionId: string, routeKey = "test-v1"): Promise<ToolExecutionContext> {
  return { runtimeGeneration: generationId, token: await issueMachineSecret(auth, machineId, "execution", 1) };
}
export interface FakeJob { id: string; body: Submission; requestHash: string; destination: { routeKey: string; sessionId: string }; machineId: string; outcome: Outcome }
export function runResult(text = "Hello\n", reason = "exited", exitCode: number | null = 0) {
  const raw = Buffer.from(text), tail = raw.subarray(-65536);
  let output = tail.toString("utf8");
  while (Buffer.byteLength(output) > 65536) output = output.slice(0, -1);
  return { session_id: null, state: "finished", exit_code: exitCode, signal: null as string | null,
    reason: reason === "start_failed" || reason === "lost" ? `${reason}: fixture failure` : reason,
    output, original_bytes: raw.length, output_truncated: raw.length > tail.length, output_incomplete: false,
    wall_time_seconds: 0.01,
    artifact: { id: "00000000-0000-4000-8000-000000000004", path: "/machine/outputs/run.log", size_bytes: raw.length, complete: true, expires_at_ms: 2000000000123 as number | null } };
}
export class FakeGateway {
  readonly requests: { path: string; authorization: string | null; body: unknown }[] = [];
  readonly jobs = new Map<string, FakeJob>(); posts = 0; details = 0; loseAcceptance = 0;
  reject: { status: number; code: string; retryable: boolean; uncertain: boolean } | undefined;
  onAccepted: ((job: FakeJob) => Promise<void>) | undefined;
  acceptanceStatus = 202;
  acceptance: ((value: Record<string, unknown>) => unknown) | undefined;
  async fetch(request: MFRequest): Promise<MFResponse> {
    if (new URL(request.url).origin !== "https://gateway.test" || !/^\/v1\/machines\/[0-9a-f-]+\/requests$/.test(new URL(request.url).pathname) || request.method !== "POST") throw Error("Only new gateway submission is supported.");
    this.posts++;
    const token = request.headers.get("Authorization")!.slice(7);
    const raw = await request.json() as Submission;
    this.requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("Authorization"), body: structuredClone(raw) });
    const credential = machineSecret(token, "execution");
    if (new URL(request.url).pathname !== `/v1/machines/${credential.machineId}/requests` || raw.runtimeGeneration !== generationId) throw Error("Machine or runtime mismatch.");
    const destination = object(raw.callback.context) as { routeKey: string; sessionId: string };
    if (this.reject) {
      const { status, ...error } = this.reject;
      return MFResponse.json({ error: { ...error, message: "not logged" } }, { status });
    }
    const body = raw;
    const requestHash = await hashJson(jsonValue({ machineId: credential.machineId, ...body }));
    let job = this.jobs.get(body.requestId);
    if (job && !isDeepStrictEqual(job.body, body)) return MFResponse.json({ error: { code: "REQUEST_CONFLICT", message: "Request identity already exists with different input.", retryable: false, uncertain: true } }, { status: 409 });
    if (!job) { job = { id: body.requestId, body, requestHash, destination, machineId: credential.machineId, outcome: { status: "error", error: { code: "pending", message: "pending", uncertain: false } } }; this.jobs.set(job.id, job); }
    await this.onAccepted?.(job);
    if (this.loseAcceptance) { this.loseAcceptance--; return new MFResponse("lost response", { status: 502 }); }
    const response = { status: "accepted", machineId: credential.machineId, requestId: job.id, requestHash, runtimeGeneration: generationId };
    return MFResponse.json(this.acceptance ? this.acceptance(response) : response, { status: this.acceptanceStatus });
  }
  finish(job: FakeJob, value: unknown = runResult()) { job.outcome = { status: "ok", result: jsonValue(value) }; }
  fileError(job: FakeJob, code: string, message: string, uncertain = false) { job.outcome = { status: "error", error: { code, message, uncertain } }; }
}
export async function event(job: FakeJob): Promise<CompletionEvent> {
  const resultHash = await hashJson(jsonValue(job.outcome));
  return { protocolVersion: 1, machineId: job.machineId, runtimeGeneration: generationId, requestId: job.id, requestHash: job.requestHash,
    callback: job.body.callback, outcome: job.outcome, resultHash,
    deliveryId: await hashJson({ requestHash: job.requestHash, resultHash }) };
}
export type Snapshot = { admittedCompletions: number; results: { event_id: string; payload: string }[];
  operations: { operationId: string; submissionId: string; jobId: string; outcome: OperationOutcome | null }[]; progress: { blocked: boolean }; outbox: unknown[] };
export async function bundle(path: string) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:buffer"], write: false });
  return result.outputFiles[0]!.text;
}
export async function startStack(gateway = new FakeGateway(), options: { persistPath?: string } = {}) {
  const [worker, fixture] = await Promise.all([bundle("../src/index.ts"), bundle("./fixture.ts")]);
  const common = { modules: true, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"], bindings: {
    EXECUTION_GATEWAY_URL: "https://gateway.test", SESSION_ROUTES: JSON.stringify({ "test-v1": "SESSIONS" }) }, outboundService: (request: MFRequest) => gateway.fetch(request) };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "bash", script: worker, durableObjects: { SESSIONS: { className: "TestSession", scriptName: "host" } } },
    { ...common, name: "host", script: fixture, serviceBindings: { BASH: { name: "bash", entrypoint: "PiBash" }, BASH_EVENTS: { name: "bash", entrypoint: "PiBashCallbacks" } }, durableObjects: { SESSIONS: { className: "TestSession", useSQLite: true } } },
  ], ...(options.persistPath ? { durableObjectsPersist: `${options.persistPath}/objects` } : {}) });
  const host = await app.getWorker("host"), bash = await app.getWorker("bash");
  return { app, gateway, bash, async call<T = Snapshot>(path: string, body: unknown = {}): Promise<T> {
    const res = await host.fetch(`https://test${path}`, { method: "POST", body: JSON.stringify(body) }); const value: unknown = await res.json();
    if (!res.ok) throw Error(JSON.stringify(value)); return value as T;
  } };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
export async function until<T>(get: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) { const result = await get(); if (result !== undefined) return result; await setTimeout(20); } throw Error("Condition did not become true.");
}
