import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import type { LlmInput, LlmSubmission, OperationOutcome } from "@managed-agents/contracts";

export const config = { provider: "openai", modelId: "gpt-5.6-sol", accountId: "11111111-1111-4111-8111-111111111111", machineId: "22222222-2222-4222-8222-222222222222", cwd: "/workspace" };
export const token = "test-backend-token";
export type Job = { id: string; outcome: string | null; submissions: number; request: LlmSubmission };
export type Page = { messages: { sequence: number; message: { role: string; tag?: string; content?: unknown[] }; inContext: boolean }[]; nextCursor: number | null;
  state: { status: string; phase: string; runId: string; pendingMessageCount: number; activeOperationId: string | null; processingBlocked: boolean } };
export async function bundle(path: string) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, format: "esm", platform: "browser",
    target: "es2022", external: ["cloudflare:workers"], write: false });
  return result.outputFiles[0]!.text;
}
export async function startStack(persistPath?: string) {
  const [api, host, fixture] = await Promise.all([bundle("../../agent-api/src/index.ts"), bundle("../src/index.ts"), bundle("./fixture.ts")]);
  const common = { modules: true, compatibilityDate: "2026-07-30", outboundService: () => { throw new Error("Test must not call external services."); } };
  const ns = { MINIMAL_BASH_SESSIONS: { className: "MinimalBashSession", scriptName: "host" } };
  const d1Databases = { SESSION_DIRECTORY: "minimal-bash-directory" };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "api", script: api, d1Databases, durableObjects: ns, bindings: { BACKEND_TOKEN: token } },
    { ...common, name: "host", script: host, d1Databases, durableObjects: { MINIMAL_BASH_SESSIONS: { className: "MinimalBashSession", useSQLite: true } },
      serviceBindings: { LLM: { name: "operations", entrypoint: "FakeOperations" }, BASH: { name: "operations", entrypoint: "FakeOperations" } } },
    { ...common, name: "operations", script: fixture, d1Databases, durableObjects: { ...ns, JOBS: { className: "FakeJobs", useSQLite: true } } },
  ], ...(persistPath ? { durableObjectsPersist: `${persistPath}/objects`, d1Persist: `${persistPath}/d1` } : {}) });
  try {
    const db = await app.getD1Database("SESSION_DIRECTORY", "api");
    if (!await db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").first()) {
      const sql = await readFile(new URL("../../agent-api/migrations/0001_initial.sql", import.meta.url), "utf8");
      for (const statement of sql.split(";").filter(s => s.trim())) await db.prepare(statement).run();
    }
    const control = await app.getWorker("operations");
    async function request<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown, expected = 200): Promise<T> {
      const response = await app.dispatchFetch(`https://api${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as T;
    }
    return { app, db, request,
      async create(key: string, overrides = {}) {
        const result = await request<{ session: { identity: { sessionId: string } } }>("/v1/sessions", "POST", {
          requestId: key, harness: { id: "minimal-bash", version: "v1" }, config: { ...config, ...overrides }, metadata: { title: key },
        }, 201); return result.session.identity.sessionId;
      },
      async control<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
        const response = await control.fetch(`https://test${path}`, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value as T;
      },
      page: (id: string) => request<Page>(`/v1/sessions/${id}/messages`),
      input: (id: string, eventId: string, type = "minimal_bash.message", payload: unknown = { message: { role: "user", content: [{ type: "text", text: eventId }] } }) =>
        request(`/v1/sessions/${id}/inputs`, "POST", { eventId, event: { type, payload } }, 202),
    };
  } catch (error) { await app.dispose(); throw error; }
}
export async function until<T>(fn: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12_000; let value: T;
  do { value = await fn(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 30)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(value!)}`);
}
export const llmResult = (tools: string[] = []): OperationOutcome => ({ status: "succeeded", result: {
  gatewayJobId: "fake-gateway", response: { id: "response", modelId: config.modelId, durationMs: 1, timestamp: 1, stopReason: tools.length ? "tool_use" : "stop",
    message: { role: "assistant", provider: "openai", content: tools.length ? tools.map((command, i) => ({ type: "function_call", call_id: `call-${i}`, id: `item-${i}`, name: "bash", arguments: JSON.stringify({ command }) }))
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }] } },
} });
export const bashResult: OperationOutcome = { status: "succeeded", result: { content: [{ type: "text", text: "ok" }], isError: false, details: { reason: "exited", exitCode: 0 } } };
export const llmInput = (job: Job) => job.request.submission.request.input as Exclude<LlmInput, { previousJobId: string }>;
