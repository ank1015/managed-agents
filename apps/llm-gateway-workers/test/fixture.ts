import { DurableObject } from "cloudflare:workers";
import { LLM_OPERATION, parseLlmInput, parseJsonValue, parseProviderSubmitResult, parseProviderStatusResult } from "@managed-agents/contracts";
import type { EventBody, JsonValue, LlmWorkerBinding } from "@managed-agents/contracts";
import type { HarnessDefinition } from "@managed-agents/harness-api";
import { SessionDriver } from "@managed-agents/session-runtime";
import { LlmService } from "../src/service.ts";
import handler from "../src/index.ts";
import type { Env } from "../src/types.ts";

interface TestEnv extends Env { LLM: LlmWorkerBinding; SESSIONS: DurableObjectNamespace<TestSession> }
const harness: HarnessDefinition<JsonValue, EventBody> = {
  identity: { id: "llm-test", version: "v1" }, operations: [LLM_OPERATION],
  migrations: [{ version: 1, statements: ["CREATE TABLE test_results (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)"] }],
  parseConfig(value) { return parseJsonValue(parseLlmInput(value)); },
  parseInput: event => event,
  initialize(ctx) { ctx.requestOperation({ ...LLM_OPERATION, input: ctx.config as JsonValue }); },
  handle(input, ctx) { ctx.sql.exec("INSERT INTO test_results VALUES (?, ?)", input.eventId, JSON.stringify(input.event)); },
};
/** Test-only harness: exercises the production driver, RPC adapter, SQLite, and admission receipt. */
export class TestSession extends DurableObject<TestEnv> {
  readonly driver: SessionDriver<JsonValue, EventBody>;
  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
    this.driver = new SessionDriver(ctx.storage, harness, {
      providers: { llm: {
        submit: async submission => parseProviderSubmitResult(JSON.parse(await env.LLM.submit(JSON.stringify({
          destination: { routeKey: "test-v1", sessionId: this.driver.getSession().identity.sessionId }, submission,
        })))),
        get: async query => parseProviderStatusResult(JSON.parse(await env.LLM.get(JSON.stringify(query)))),
      } },
      policy: { reconcileMs: 3_600_000, retryBaseMs: 50, retryMaxMs: 100 },
      waitUntil: promise => ctx.waitUntil(promise),
    });
  }
  async start(sessionId: string, serialized: string): Promise<string> {
    return JSON.stringify(await this.driver.initialize({ session: { sessionId, harness: harness.identity }, config: JSON.parse(serialized) }));
  }
  alarm() { return this.driver.alarm(); }
  async sessionRequest(serialized: string): Promise<string> {
    const fail = await this.ctx.storage.get<number>("fail") ?? 0;
    if (fail) { await this.ctx.storage.put("fail", fail - 1); throw new Error("Injected delivery failure."); }
    const command = JSON.parse(serialized);
    if (command.action !== "acceptCompletion") throw new Error("Unexpected action.");
    const receipt = await this.driver.acceptCompletion(command.value);
    const lose = await this.ctx.storage.get<number>("lose") ?? 0;
    if (lose) { await this.ctx.storage.put("lose", lose - 1); throw new Error("Injected lost durable receipt."); }
    return JSON.stringify({ ok: true, value: receipt });
  }
  async faults(fail: number, lose: number) { await this.ctx.storage.put({ fail, lose }); }
  snapshot() {
    const rows = this.ctx.storage.sql.exec<{ operation_id: string }>("SELECT operation_id FROM runtime_operations").toArray();
    return JSON.stringify({ operations: rows.map(row => this.driver.getOperation(row.operation_id)),
      outbox: this.ctx.storage.sql.exec("SELECT * FROM runtime_outbox").toArray(),
      results: this.ctx.storage.sql.exec("SELECT * FROM test_results").toArray() });
  }
}
export default {
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname;
      const body = await request.json() as { sessionId: string; input: JsonValue; fail?: number; lose?: number };
      if (path === "/submit" || path === "/get") return new Response(await env.LLM[path.slice(1) as "submit" | "get"](JSON.stringify(body)));
      if (path === "/recover") {
        await handler.scheduled({} as ScheduledController, env); return Response.json({ ok: true });
      }
      if (path === "/process") return Response.json({ delay: await new LlmService(env).process(body as never) ?? null });
      const session = env.SESSIONS.get(env.SESSIONS.idFromName(body.sessionId));
      if (path === "/start") return new Response(await session.start(body.sessionId, JSON.stringify(body.input)));
      if (path === "/faults") { await session.faults(body.fail ?? 0, body.lose ?? 0); return Response.json({ ok: true }); }
      if (path === "/snapshot") return new Response(await session.snapshot());
      return new Response(null, { status: 404 });
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  },
} satisfies ExportedHandler<TestEnv>;
