import { issueMachineSecret } from "@managed-agents/execution-gateway-protocol";
import { DurableObject } from "cloudflare:workers";
import { PI_READ_OPERATION, parseReadInput, parseJsonValue, parseProviderSubmitReply, parseSessionCommand } from "@managed-agents/contracts";
import type { EventBody, JsonValue, ReadWorkerBinding, SessionReply } from "@managed-agents/contracts";
import type { HarnessDefinition } from "@managed-agents/harness-api";
import { SessionDriver } from "@managed-agents/session-runtime";
import type { Env } from "../src/types.ts";

interface TestEnv extends Env { READ: ReadWorkerBinding; READ_EVENTS: { acceptExecutionResult(value: unknown): Promise<unknown> }; SESSIONS: DurableObjectNamespace<TestSession> }
const harness: HarnessDefinition<JsonValue, EventBody> = {
  identity: { id: "read-test", version: "v1" }, operations: [PI_READ_OPERATION],
  schema: ["CREATE TABLE test_results (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)"],
  parseConfig(value) { return parseJsonValue(parseReadInput(value)); },
  parseInput: event => event,
  initialize() {},
  handle(input, ctx) {
    return { changes: input.event.type === "start" ? null : { eventId: input.eventId, event: input.event },
      operations: input.event.type === "start" ? [{ key: "request", ...PI_READ_OPERATION, input: ctx.config as JsonValue }] : [] };
  },
  apply(changes, ctx) {
    if (changes) {
      const c = changes as { eventId: string; event: unknown };
      ctx.sql.exec("INSERT INTO test_results VALUES (?, ?)", c.eventId, JSON.stringify(c.event));
    }
  },
};
/** Test-only harness: exercises the production driver, RPC adapter, SQLite, and admission receipt. */
export class TestSession extends DurableObject<TestEnv> {
  readonly driver: SessionDriver<JsonValue, EventBody>;
  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
    this.driver = new SessionDriver(ctx.storage, harness, {
      providers: { "tool-pi-read": {
        submit: async submission => parseProviderSubmitReply(await env.READ.submit({
          destination: { routeKey: "test-v1", sessionId: this.driver.getSession().identity.sessionId }, submission,
          execution: await ctx.storage.get("execution") ?? await execution(this.driver.getSession().identity.sessionId),
        })),
      } },
      policy: { retryBaseMs: 50, retryMaxMs: 100 },
      waitUntil: promise => ctx.waitUntil(promise),
    });
  }
  async start(sessionId: string, serialized: string, execution?: unknown): Promise<string> {
    if (execution) await this.ctx.storage.put("execution", execution);
    const initialized = await this.driver.initialize({ session: { sessionId, harness: harness.identity }, config: JSON.parse(serialized) });
    await this.driver.appendInput({ eventId: "start", event: { type: "start", payload: null } });
    return JSON.stringify(initialized);
  }
  alarm() { return this.driver.alarm(); }
  async sessionRequest(value: unknown): Promise<SessionReply<unknown>> {
    const delay = await this.ctx.storage.get<number>("delay") ?? 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const fail = await this.ctx.storage.get<number>("fail") ?? 0;
    if (fail) { await this.ctx.storage.put("fail", fail - 1); throw new Error("Injected delivery failure."); }
    const command = parseSessionCommand(value);
    if (command.action !== "acceptToolCompletion") throw new Error("Unexpected action.");
    const receipt = await this.driver.acceptCompletion((command.value as { completion: unknown }).completion);
    const lose = await this.ctx.storage.get<number>("lose") ?? 0;
    if (lose) { await this.ctx.storage.put("lose", lose - 1); throw new Error("Injected lost durable receipt."); }
    const invalid = await this.ctx.storage.get<number>("invalid") ?? 0;
    if (invalid) { await this.ctx.storage.put("invalid", invalid - 1); return { ok: true, value: { ...receipt, operationId: "wrong" } }; }
    return { ok: true, value: receipt };
  }
  async faults(fail: number, lose: number, invalid: number, delay: number) { await this.ctx.storage.put({ fail, lose, invalid, delay }); }
  snapshot() {
    const results = this.ctx.storage.sql.exec<{ event_id: string; payload: string }>("SELECT * FROM test_results").toArray();
    const completed = results.map(row => JSON.parse(row.payload).payload).map(p => ({ ...p, submissionId: p.operationId }));
    return JSON.stringify({ admittedCompletions: this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_inbox WHERE event_id LIKE 'runtime:%'").one().n, progress: this.driver.getProcessingStatus(), operations: [...this.driver.getPendingOperations().map(p => ({ ...p, submissionId: p.operationId, outcome: null })), ...completed],
      // Assert the removed table is absent, not that an old outbox happened to drain.
      outbox: this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'runtime_outbox'").toArray(), results });
  }
}
export default {
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname;
      const body = await request.json() as { sessionId: string; input: JsonValue; execution?: unknown; fail?: number; lose?: number; invalid?: number; delay?: number };
      if (path === "/submit") return Response.json(parseProviderSubmitReply(await env.READ.submit(body)));
      if (path === "/event") return Response.json(await env.READ_EVENTS.acceptExecutionResult(body));
      if (path === "/callback-submit") return Response.json(await (env.READ_EVENTS as unknown as ReadWorkerBinding).submit(body));
      const session = env.SESSIONS.get(env.SESSIONS.idFromName(body.sessionId));
      if (path === "/start") return new Response(await session.start(body.sessionId, JSON.stringify(body.input), body.execution));
      if (path === "/faults") { await session.faults(body.fail ?? 0, body.lose ?? 0, body.invalid ?? 0, body.delay ?? 0); return Response.json({ ok: true }); }
      if (path === "/snapshot") return new Response(await session.snapshot());
      return new Response(null, { status: 404 });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
} satisfies ExportedHandler<TestEnv>;

async function execution(sessionId: string) {
  const stored = { runtimeGeneration:"00000000-0000-4000-8000-000000000002" };
  return {...stored, token: await issueMachineSecret("read-test-signing-secret-at-least-32-bytes", "00000000-0000-4000-8000-000000000001", "execution", 1)};
}
