import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";
import { ContractException, jsonEquals, parseJsonValue } from "@managed-agents/contracts";
import type { EventBody, JsonValue, OperationCompletion, ProviderSubmission } from "@managed-agents/contracts";
import type { HarnessContext, HarnessDefinition } from "@managed-agents/harness-api";
import { SessionDriver, SessionRuntime } from "../src/index.ts";
import type { DriverPolicy, OperationProvider } from "../src/index.ts";
import { OperationStore } from "../src/storage/operations.ts";
import type { SubmissionAction } from "../src/storage/operations.ts";
import { jsonChunksSchema, readJson, writeJson } from "@managed-agents/sqlite-json";

interface Env { SESSIONS: DurableObjectNamespace; PROVIDERS: DurableObjectNamespace }
type Settings = { policy?: Partial<DriverPolicy>; fixed?: boolean; failCompletion?: boolean; failInitialize?: boolean };
const policy: Partial<DriverPolicy> = {
  maxSteps: 4, maxSliceMs: 100, providerTimeoutMs: 200, attemptLeaseMs: 300,
  recoveryMs: 500, continuationMs: 10, retryBaseMs: 30, retryMaxMs: 100, reconcileMs: 40, maxHandlerFailures: 3,
};

/** Test-only host. Raw SQL/manual transition commands are fault-injection surfaces, not production APIs. */
export class OperationsFixture {
  core: SessionRuntime<JsonValue, EventBody>;
  driver: SessionDriver<JsonValue, EventBody>;
  retained: HarnessContext<JsonValue> | undefined;
  settings: Settings;
  constructor(readonly state: DurableObjectState, readonly env: Env) {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_settings (singleton INTEGER PRIMARY KEY, json TEXT NOT NULL)");
    const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM test_settings").toArray()[0];
    this.settings = row ? JSON.parse(row.json) as Settings : {};
    const harness: HarnessDefinition<JsonValue, EventBody> = {
      identity: { id: "operations-test", version: "v1" },
      operations: [{ provider: "echo", type: "echo", version: "v1" }],
      migrations: [{ version: 1, statements: [
        "CREATE TABLE h_pending(operation_id TEXT PRIMARY KEY, result_json TEXT)",
        "CREATE TABLE h_events(event_id TEXT PRIMARY KEY)",
        jsonChunksSchema("h_chunks"),
      ] }],
      parseConfig: value => value,
      parseInput: event => {
        if (!["request", "fail-request", "record", "fail"].includes(event.type)) throw new ContractException("INVALID_INPUT", "Unknown input.");
        return event;
      },
      initialize: ctx => {
        this.retained = ctx;
        if (ctx.config === "request") this.request(ctx, { mode: "immediate" });
        if (this.settings.failInitialize) throw new Error("initialize failed");
      },
      handle: (input, ctx) => {
        this.retained = ctx;
        ctx.sql.exec("INSERT INTO h_events VALUES (?)", input.eventId).toArray();
        if (input.event.type === "runtime.operation.completed") {
          const p = input.event.payload as { operationId: string; outcome: JsonValue };
          ctx.sql.exec("UPDATE h_pending SET result_json = ? WHERE operation_id = ?", writeJson(ctx.sql, "h_chunks", p.outcome), p.operationId).toArray();
          if (this.settings.failCompletion && !this.settings.fixed) throw new Error("completion handler failed");
        } else if (input.event.type === "request" || input.event.type === "fail-request") {
          this.request(ctx, input.event.payload);
          if (input.event.type === "fail-request" && !this.settings.fixed) throw new Error("request handler failed");
        } else {
          if (input.event.type === "fail" && !this.settings.fixed) throw new Error("handler failed");
        }
      },
    };
    this.core = new SessionRuntime(state.storage, harness);
    const provider: OperationProvider = {
      submit: async (submission, signal) => {
        const response = await env.PROVIDERS.get(env.PROVIDERS.idFromName("provider")).fetch("https://provider/", {
          method: "POST", body: JSON.stringify({ op: "submit", value: submission }), signal,
        });
        if (!response.ok) throw new Error("transient submit failure");
        return response.json();
      },
      get: async (query, signal) => {
        const response = await env.PROVIDERS.get(env.PROVIDERS.idFromName("provider")).fetch("https://provider/", {
          method: "POST", body: JSON.stringify({ op: "get", value: query }), signal,
        });
        if (!response.ok) throw new Error("transient status failure");
        return response.json();
      },
    };
    this.driver = new SessionDriver(state.storage, harness, {
      providers: { echo: provider }, policy: { ...policy, ...this.settings.policy },
      waitUntil: promise => state.waitUntil(promise),
    });
  }

  request(ctx: HarnessContext<JsonValue>, input: JsonValue): void {
    const id = ctx.requestOperation({ provider: "echo", type: "echo", version: "v1", input });
    ctx.sql.exec("INSERT INTO h_pending(operation_id) VALUES (?)", id).toArray();
  }

  async alarm(): Promise<void> { await this.driver.alarm(); }

  async fetch(request: Request): Promise<Response> {
    try {
      const { op, value } = await request.json() as { op: string; value: unknown };
      let result: unknown;
      switch (op) {
        case "settings":
          this.settings = value as Settings;
          this.state.storage.sql.exec("INSERT OR REPLACE INTO test_settings VALUES (1, ?)", JSON.stringify(value)).toArray();
          break;
        case "initialize": result = await this.driver.initialize(value); break;
        case "append": result = await this.driver.appendInput(value); break;
        case "completion": result = await this.driver.acceptCompletion(value); break;
        case "resume": await this.driver.resumeProcessing(); break;
        case "run": await this.driver.run(); break;
        case "progress": result = this.driver.getProcessingStatus(); break;
        case "operation": result = this.driver.getOperation(value as string); break;
        case "alarm": result = await this.state.storage.getAlarm(); break;
        case "arm": await this.state.storage.setAlarm(Date.now() + Number(value)); break;
        case "coreInitialize": result = this.core.initialize(value); break;
        case "coreAppend": result = this.core.appendInput(value); break;
        case "coreProcess": result = this.core.processNext(); break;
        case "coreCompletion": result = this.core.acceptCompletion(value); break;
        case "harnessResult": {
          const row = this.state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM h_pending WHERE operation_id = ?", value as string).one();
          result = readJson(this.state.storage.sql, "h_chunks", row.result_json); break;
        }
        case "expired": this.retained!.requestOperation({ provider: "echo", type: "echo", version: "v1", input: null }); break;
        case "claim": result = new OperationStore(this.state.storage).claim(Date.now(), 300); break;
        case "submitted": {
          const v = value as { action: SubmissionAction; result: Parameters<OperationStore["submitted"]>[1] };
          new OperationStore(this.state.storage).submitted(v.action, v.result, Date.now(), 40); break;
        }
        case "sql": {
          const v = value as { query: string; bindings?: (string | number | null)[] };
          result = this.state.storage.sql.exec(v.query, ...v.bindings ?? []).toArray(); break;
        }
        default: throw new Error(`Unknown command ${op}`);
      }
      return Response.json(result ?? null);
    } catch (error) {
      return Response.json({ error: error instanceof ContractException ? error.toJSON() : { message: String(error) } }, { status: 400 });
    }
  }
}

type Job = { submission_id: string; job_id: string; request_json: string; submits: number; gets: number; ready: number };

/** The provider owns its durable jobs in a separate DO/database, surviving session activation loss. */
export class ProviderFixture {
  constructor(readonly state: DurableObjectState, readonly env: Env) {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS submit_calls (submission_id TEXT PRIMARY KEY, calls INTEGER NOT NULL)");
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      submission_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, request_json TEXT NOT NULL,
      submits INTEGER NOT NULL, gets INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 1
    )`);
  }
  async fetch(request: Request): Promise<Response> {
    const { op, value } = await request.json() as { op: string; value: ProviderSubmission & { jobId?: string } };
    const sql = this.state.storage.sql;
    if (op === "jobs") return Response.json(sql.exec("SELECT * FROM jobs").toArray());
    if (op === "calls") return Response.json(sql.exec("SELECT * FROM submit_calls").toArray());
    if (op === "ready") { sql.exec("UPDATE jobs SET ready = 1").toArray(); return Response.json(null); }
    let job = sql.exec<Job>("SELECT * FROM jobs WHERE submission_id = ?", value.submissionId).toArray()[0];
    if (op === "submit") {
      if (job && !jsonEquals(JSON.parse(job.request_json) as JsonValue, parseJsonValue(value.request))) {
        return new Response("idempotency conflict", { status: 409 });
      }
      const input = value.request.input as { mode?: string; sessionName?: string };
      const mode = input?.mode;
      if (mode === "reject") return Response.json({ status: "rejected", error: { code: "REJECTED", message: "Definitive rejection" } });
      const { calls } = sql.exec<{ calls: number }>(`INSERT INTO submit_calls VALUES (?, 1)
        ON CONFLICT(submission_id) DO UPDATE SET calls = calls + 1 RETURNING calls`, value.submissionId).one();
      if (mode === "transient" && calls <= 2) return new Response("temporarily unavailable before acceptance", { status: 503 });
      if (!job) {
        sql.exec("INSERT INTO jobs(submission_id, job_id, request_json, submits, ready) VALUES (?, ?, ?, 0, ?)",
          value.submissionId, crypto.randomUUID(), JSON.stringify(value.request), mode === "pending" ? 0 : 1).toArray();
      }
      job = sql.exec<Job>("UPDATE jobs SET submits = submits + 1 WHERE submission_id = ? RETURNING *", value.submissionId).one();
      const outcome = { status: "succeeded", result: input };
      if (mode === "lost" && job.submits === 1) {
        return new Response("lost submission response", { status: 503 });
      }
      if ((mode === "delay" || mode === "timeout") && job.submits === 1) await new Promise(resolve => setTimeout(resolve, mode === "delay" ? 100 : 350));
      if (mode === "early" || mode === "early-rejected") {
        const completion = { operationId: value.operationId, submissionId: value.submissionId, provider: "echo", jobId: job.job_id, outcome };
        const target = this.env.SESSIONS.get(this.env.SESSIONS.idFromName(input.sessionName!));
        for (let i = 0; i < 2; i++) {
          const r = await target.fetch("https://session/", { method: "POST", body: JSON.stringify({ op: "completion", value: completion }) });
          if (!r.ok) throw new Error(await r.text());
        }
        if (mode === "early-rejected") return Response.json({ status: "rejected", error: { code: "LATE", message: "Stale rejection" } });
      }
      return Response.json(mode === "immediate" ? { status: "completed", jobId: job.job_id, outcome } : { status: "accepted", jobId: job.job_id });
    }
    if (!job) return Response.json({ status: "missing" });
    if (job.job_id !== value.jobId) return new Response("wrong job", { status: 409 });
    job = sql.exec<Job>("UPDATE jobs SET gets = gets + 1 WHERE submission_id = ? RETURNING *", value.submissionId).one();
    const input = (JSON.parse(job.request_json) as ProviderSubmission["request"]).input as { mode?: string };
    if (input.mode === "status-transient" && job.gets <= 2) return new Response("status unavailable", { status: 503 });
    if (input.mode === "missing" && job.gets === 1) return Response.json({ status: "missing" });
    return Response.json(job.ready ? { status: "completed", outcome: { status: "succeeded", result: input } } : { status: "pending" });
  }
}
