import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";
import { ContractException, jsonEquals, parseJsonValue } from "@managed-agents/contracts";
import type { EventBody, JsonValue, ProviderSubmission, InputEnvelope, RuntimeEvent } from "@managed-agents/contracts";
import type { HarnessDefinition, HarnessReadContext } from "@managed-agents/harness-api";
import { SessionDriver, SessionRuntime } from "../src/index.ts";
import type { DriverPolicy, PreparedTransition } from "../src/index.ts";

interface Env { SESSIONS: DurableObjectNamespace; PROVIDERS: DurableObjectNamespace }
type Settings = { policy?: Partial<DriverPolicy>; fixed?: boolean; failCompletion?: boolean; failInitialize?: boolean };
type Changes = InputEnvelope<EventBody | RuntimeEvent>;
const policy: Partial<DriverPolicy> = {
  maxSteps: 4, maxSliceMs: 100, providerTimeoutMs: 200, recoveryMs: 500,
  continuationMs: 10, retryBaseMs: 30, retryMaxMs: 100, maxHandlerFailures: 3,
};
/** Test-only fault injection host. */
export class OperationsFixture {
  core: SessionRuntime<JsonValue, EventBody, Changes>;
  driver: SessionDriver<JsonValue, EventBody, Changes>;
  retained: HarnessReadContext<JsonValue> | undefined;
  settings: Settings;
  prepared: PreparedTransition<Changes> | undefined;
  constructor(readonly state: DurableObjectState, readonly env: Env) {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_settings (singleton INTEGER PRIMARY KEY, json TEXT NOT NULL)");
    const row = state.storage.sql.exec<{ json: string }>("SELECT json FROM test_settings").toArray()[0];
    this.settings = row ? JSON.parse(row.json) as Settings : {};
    const harness: HarnessDefinition<JsonValue, EventBody, Changes> = {
      identity: { id: "operations-test", version: "v1" },
      operations: [{ provider: "echo", type: "echo", version: "v1" }],
      schema: ["CREATE TABLE h_results(operation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL)",
        "CREATE TABLE h_events(event_id TEXT PRIMARY KEY)"],
      parseConfig: value => value,
      parseInput: event => {
        if (!["request", "fail-request", "record", "fail"].includes(event.type)) throw new ContractException("INVALID_INPUT", "Unknown input.");
        return event;
      },
      initialize: () => { if (this.settings.failInitialize) throw new Error("initialize failed"); },
      handle: (input, ctx) => {
        this.retained = ctx;
        if (["fail", "fail-request"].includes(input.event.type) && !this.settings.fixed) throw new Error("handler failed");
        const requests = input.event.type === "request" || input.event.type === "fail-request"
          ? (Array.isArray(input.event.payload) ? input.event.payload : [input.event.payload]) : [];
        return { changes: input, operations: requests.map((value, i) => ({
          key: String(i), provider: "echo", type: "echo", version: "v1",
          input: value && typeof value === "object" && !Array.isArray(value) && typeof value.generateBytes === "number"
            ? "x".repeat(value.generateBytes) : value,
        })) };
      },
      apply: (input, ctx) => {
        ctx.sql.exec("INSERT INTO h_events VALUES (?)", input.eventId).toArray();
        if (input.event.type === "runtime.operation.completed") {
          const payload = input.event.payload as RuntimeEvent["payload"];
          ctx.sql.exec("INSERT INTO h_results VALUES (?, ?)", payload.operationId, JSON.stringify(payload.outcome)).toArray();
          if (this.settings.failCompletion && !this.settings.fixed) throw new Error("completion apply failed");
        }
      },
    };
    this.core = new SessionRuntime(state.storage, harness);
    this.driver = new SessionDriver(state.storage, harness, {
      providers: { echo: { submit: async (submission, signal) => {
        const r = await env.PROVIDERS.get(env.PROVIDERS.idFromName("provider")).fetch("https://provider/", {
          method: "POST", body: JSON.stringify({ op: "submit", value: submission }), signal,
        });
        if (!r.ok) throw new Error("transient submit failure");
        return r.json();
      } } }, policy: { ...policy, ...this.settings.policy }, waitUntil: promise => state.waitUntil(promise),
    });
  }
  async alarm(): Promise<void> { await this.driver.alarm(); }
  async fetch(request: Request): Promise<Response> {
    try {
      const { op, value } = await request.json() as { op: string; value: any };
      let result: unknown;
      switch (op) {
        case "settings":
          this.settings = value;
          this.state.storage.sql.exec("INSERT OR REPLACE INTO test_settings VALUES (1, ?)", JSON.stringify(value)); break;
        case "initialize": result = await this.driver.initialize(value); break;
        case "append": result = await this.driver.appendInput(value); break;
        case "completion": result = await this.driver.acceptCompletion(value); break;
        case "resume": await this.driver.resumeProcessing(); break;
        case "run": await this.driver.run(); break;
        case "progress": result = this.driver.getProcessingStatus(); break;
        case "alarm": result = await this.state.storage.getAlarm(); break;
        case "arm": await this.state.storage.setAlarm(Date.now() + Number(value)); break;
        case "coreInitialize": result = this.core.initialize(value); break;
        case "coreAppend": result = this.core.appendInput(value); break;
        case "prepare": this.prepared = this.core.prepareNext(); result = this.prepared; break;
        case "commit": result = this.core.commit(this.prepared!, value); this.prepared = undefined; break;
        case "coreProcess": {
          const plan = this.core.prepareNext();
          result = plan ? this.core.commit(plan, plan.operations.map(op => ({
            operationId: op.operationId, result: { status: "accepted", jobId: "job-" + op.operationId },
          }))) : { processed: false }; break;
        }
        case "coreCompletion": result = this.core.acceptCompletion(value); break;
        case "harnessResult": {
          const row = this.state.storage.sql.exec<{ result_json: string }>("SELECT result_json FROM h_results WHERE operation_id = ?", value).one();
          result = JSON.parse(row.result_json); break;
        }
        case "expired": this.retained!.operationId("late"); break;
        case "sql": result = this.state.storage.sql.exec(value.query, ...value.bindings ?? []).toArray(); break;
        default: throw new Error("Unknown command " + op);
      }
      return Response.json(result ?? null);
    } catch (error) {
      return Response.json({ error: error instanceof ContractException ? error.toJSON() : { message: String(error) } }, { status: 400 });
    }
  }
}
type Job = { submission_id: string; job_id: string; request_json: string; submits: number };
/** Worker-owned jobs survive session activation loss. No status polling by the runtime. */
export class ProviderFixture {
  constructor(readonly state: DurableObjectState, readonly env: Env) {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS jobs(submission_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, request_json TEXT NOT NULL, submits INTEGER NOT NULL)");
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS calls(submission_id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  }
  async fetch(request: Request): Promise<Response> {
    const { op, value } = await request.json() as { op: string; value: ProviderSubmission };
    const sql = this.state.storage.sql;
    if (op === "jobs") return Response.json(sql.exec("SELECT * FROM jobs").toArray());
    if (op !== "submit") throw new Error("Only submission is supported");
    const { n } = sql.exec<{ n: number }>("INSERT INTO calls VALUES (?, 1) ON CONFLICT(submission_id) DO UPDATE SET n = n + 1 RETURNING n", value.submissionId).one();
    const payload = value.request.input as { mode?: string; sessionName?: string };
    if (payload?.mode === "reject") return Response.json({ status: "rejected", error: { code: "REJECTED", message: "Definitive rejection" } });
    if (payload?.mode === "transient" && n <= 2) return new Response("unavailable", { status: 503 });
    const existing = sql.exec<Job>("SELECT * FROM jobs WHERE submission_id = ?", value.submissionId).toArray()[0];
    if (existing && !jsonEquals(JSON.parse(existing.request_json) as JsonValue, parseJsonValue(value.request))) return new Response("conflict", { status: 409 });
    if (!existing) sql.exec("INSERT INTO jobs VALUES (?, ?, ?, 0)", value.submissionId, crypto.randomUUID(), JSON.stringify(value.request));
    const job = sql.exec<Job>("UPDATE jobs SET submits = submits + 1 WHERE submission_id = ? RETURNING *", value.submissionId).one();
    if (payload?.mode === "lost" && job.submits === 1) return new Response("lost acceptance", { status: 503 });
    if (payload?.mode === "timeout" && job.submits === 1) await new Promise(resolve => setTimeout(resolve, 350));
    const outcome = { status: "succeeded", result: payload };
    if (payload?.mode === "early") {
      const target = this.env.SESSIONS.get(this.env.SESSIONS.idFromName(payload.sessionName!));
      const completion = { operationId: value.operationId, submissionId: value.submissionId, provider: "echo", jobId: job.job_id, outcome };
      for (let i = 0; i < 2; i++) {
        const response = await target.fetch("https://session/", { method: "POST", body: JSON.stringify({ op: "completion", value: completion }) });
        if (!response.ok) throw new Error(await response.text());
      }
      return Response.json({ status: "accepted", jobId: job.job_id });
    }
    return Response.json(payload?.mode === "pending" ? { status: "accepted", jobId: job.job_id } : { status: "completed", jobId: job.job_id, outcome });
  }
}
