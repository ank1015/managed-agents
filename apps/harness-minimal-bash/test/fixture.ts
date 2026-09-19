import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { parseBashSubmission, parseLlmSubmission, parseProviderStatusQuery } from "@managed-agents/contracts";
import type { OperationOutcome, LlmSubmission } from "@managed-agents/contracts";
import { recoverStatuses, publishStatus } from "../src/status.ts";
import type { Env } from "../src/types.ts";

interface TestEnv extends Env { JOBS: DurableObjectNamespace<FakeJobs> }
type Job = { id: string; serialized: string; outcome: string | null; submissions: number };
/** Test-only durable external system. Never included in the production entrypoint. */
export class FakeJobs extends DurableObject<TestEnv> {
  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
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
  get(serialized: string): string {
    const query = parseProviderStatusQuery(JSON.parse(serialized));
    const row = this.ctx.storage.sql.exec<Job>("SELECT * FROM jobs WHERE id = ?", query.jobId).toArray()[0];
    return JSON.stringify(!row ? { status: "missing" } : row.outcome ? { status: "completed", outcome: JSON.parse(row.outcome) } : { status: "pending" });
  }
  list(): string { return JSON.stringify(this.ctx.storage.sql.exec<Job>("SELECT * FROM jobs ORDER BY rowid").toArray().map(row => ({ ...row, request: JSON.parse(row.serialized) }))); }
  async finish(id: string, serializedOutcome: string, deliver = true): Promise<string> {
    const row = this.ctx.storage.sql.exec<Job>("SELECT * FROM jobs WHERE id = ?", id).one();
    const outcome = JSON.parse(serializedOutcome) as OperationOutcome;
    if (row.outcome && row.outcome !== serializedOutcome) throw new Error("Conflicting fake completion.");
    this.ctx.storage.sql.exec("UPDATE jobs SET outcome = ? WHERE id = ?", serializedOutcome, id);
    if (!deliver) return "{}";
    const request = JSON.parse(row.serialized) as LlmSubmission;
    const ns = this.env.MINIMAL_BASH_SESSIONS;
    return ns.get(ns.idFromName(request.destination.sessionId)).sessionRequest(JSON.stringify({ action: "acceptCompletion", value: {
      operationId: request.submission.operationId, submissionId: request.submission.submissionId,
      provider: request.submission.request.provider, jobId: id, outcome,
    } }));
  }
}
export class FakeOperations extends WorkerEntrypoint<TestEnv> {
  submit(value: string) { return this.env.JOBS.get(this.env.JOBS.idFromName("jobs")).submit(value); }
  get(value: string) { return this.env.JOBS.get(this.env.JOBS.idFromName("jobs")).get(value); }
}
export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const jobs = env.JOBS.get(env.JOBS.idFromName("jobs"));
    if (path === "/jobs") return new Response(await jobs.list());
    if (path === "/finish") {
      const body = await request.json() as { id: string; outcome: OperationOutcome; deliver?: boolean };
      return new Response(await jobs.finish(body.id, JSON.stringify(body.outcome), body.deliver));
    }
    if (path === "/recover") { await recoverStatuses(env); return Response.json({ ok: true }); }
    if (path === "/stale-status") {
      const body = await request.json() as { sessionId: string };
      await publishStatus(env, body.sessionId, "running", 1); return Response.json({ ok: true });
    }
    if (path === "/internal") {
      const body = await request.json() as { sessionId: string; command: unknown };
      return new Response(await env.MINIMAL_BASH_SESSIONS.get(env.MINIMAL_BASH_SESSIONS.idFromName(body.sessionId)).sessionRequest(JSON.stringify(body.command)));
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<TestEnv>;
