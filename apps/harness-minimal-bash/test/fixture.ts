import { machineFixture } from "../../../packages/session-execution/test/fixture.ts";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { parseBashSubmission, parseLlmSubmission } from "@managed-agents/contracts";
import type { OperationOutcome, LlmSubmission } from "@managed-agents/contracts";
import type { Env } from "../src/types.ts";

interface TestEnv extends Env { JOBS: DurableObjectNamespace<FakeJobs> }
type Job = { id: string; serialized: string; outcome: string | null; submissions: number };
/** Test-only durable external system. Never included in the production entrypoint. */
export class FakeJobs extends DurableObject<TestEnv> {
  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS discovery(url TEXT NOT NULL, authorization TEXT)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, serialized TEXT NOT NULL, outcome TEXT, submissions INTEGER NOT NULL DEFAULT 1)");
  }
  async submit(serialized: string): Promise<string> {
    const raw = JSON.parse(serialized) as LlmSubmission;
    const request = raw.submission.request.provider === "llm" ? parseLlmSubmission(raw) : parseBashSubmission(raw);
    const id = `job-${request.submission.operationId}`;
    this.ctx.storage.transactionSync(() => {
      const prior = this.ctx.storage.sql.exec<Job>("SELECT * FROM jobs WHERE id = ?", id).toArray()[0];
      if (prior && prior.serialized !== serialized) throw new Error("Conflicting provider retry.");
      this.ctx.storage.sql.exec("INSERT INTO jobs(id,serialized) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET submissions = submissions + 1", id, serialized);
    });
    return JSON.stringify({ status: "accepted", jobId: id });
  }
  discover(url: string, authorization: string | null): void {
    this.ctx.storage.sql.exec("INSERT INTO discovery VALUES (?, ?)", url, authorization);
  }
  discoveries(): string { return JSON.stringify(this.ctx.storage.sql.exec("SELECT * FROM discovery ORDER BY rowid").toArray()); }
  list(): string { return JSON.stringify(this.ctx.storage.sql.exec<Job>("SELECT * FROM jobs ORDER BY rowid").toArray().map(row => ({ ...row, request: JSON.parse(row.serialized) }))); }
  async finish(id: string, serializedOutcome: string, deliver = true): Promise<string> {
    const row = this.ctx.storage.sql.exec<Job>("SELECT * FROM jobs WHERE id = ?", id).one();
    const outcome = JSON.parse(serializedOutcome) as OperationOutcome;
    if (row.outcome && row.outcome !== serializedOutcome) throw new Error("Conflicting fake completion.");
    this.ctx.storage.sql.exec("UPDATE jobs SET outcome = ? WHERE id = ?", serializedOutcome, id);
    if (!deliver) return "{}";
    const request = JSON.parse(row.serialized) as LlmSubmission & { execution?: Record<string, unknown> };
    const ns = this.env.MINIMAL_BASH_SESSIONS;
    const completion = { operationId: request.submission.operationId, submissionId: request.submission.submissionId,
      provider: request.submission.request.provider, jobId: id, outcome };
    return JSON.stringify(await ns.get(ns.idFromName(request.destination.sessionId)).sessionRequest(request.execution ? {
      action: "acceptToolCompletion", value: { completion, execution: { gatewayUrl: request.execution.gatewayUrl, runtimeGeneration: request.execution.runtimeGeneration,
        machineId: (request.submission.request.input as { machineId: string }).machineId } },
    } : { action: "acceptCompletion", value: completion }));
  }
}
export class FakeOperations extends WorkerEntrypoint<TestEnv> {
  async submit(value: unknown): Promise<unknown> { return { result: JSON.parse(await this.env.JOBS.get(this.env.JOBS.idFromName("jobs")).submit(JSON.stringify(value))) }; }
}
export default {
  async fetch(request, env): Promise<Response> {
    const machine = await machineFixture(request);
    if (machine) {
      await env.JOBS.get(env.JOBS.idFromName("jobs")).discover(request.url, request.headers.get("Authorization"));
      return machine;
    }
    const path = new URL(request.url).pathname;
    const jobs = env.JOBS.get(env.JOBS.idFromName("jobs"));
    if (path === "/jobs") return new Response(await jobs.list());
    if (path === "/discoveries") return new Response(await jobs.discoveries());
    if (path === "/finish") {
      const body = await request.json() as { id: string; outcome: OperationOutcome; deliver?: boolean };
      return new Response(await jobs.finish(body.id, JSON.stringify(body.outcome), body.deliver));
    }
    if (path === "/internal") {
      const body = await request.json() as { sessionId: string; command: unknown };
      return Response.json(await env.MINIMAL_BASH_SESSIONS.get(env.MINIMAL_BASH_SESSIONS.idFromName(body.sessionId)).sessionRequest(body.command));
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<TestEnv>;
