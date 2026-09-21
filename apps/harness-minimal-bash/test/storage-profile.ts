import { DurableObject } from "cloudflare:workers";
import type { SqlStorage, SqlStorageValue } from "@cloudflare/workers-types";
import type { OperationOutcome } from "@managed-agents/contracts";
import { SessionRuntime } from "@managed-agents/session-runtime";
import type { RuntimeStorage } from "@managed-agents/session-runtime";
import { minimalBashHarness } from "@managed-agents/harness-minimal-bash";

/** Real workerd counters include index maintenance, unlike node:sqlite changes(). */
export class StorageProfile extends DurableObject {
  run() {
    let transactions = 0, reads = 0, writes = 0;
    const segments: { name: string; transactions: number; reads: number; writes: number }[] = [];
    const measured: RuntimeStorage = {
      sql: { exec: (query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = this.ctx.storage.sql.exec(query, ...bindings);
        const rows = cursor.toArray();
        reads += cursor.rowsRead; writes += cursor.rowsWritten;
        return { toArray: () => rows, one: () => {
          if (rows.length !== 1) throw new Error("Expected one row");
          return rows[0];
        }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      } } as unknown as SqlStorage,
      transactionSync: <T>(fn: () => T): T => {
        transactions++;
        return this.ctx.storage.transactionSync(fn);
      },
    };
    const runtime = new SessionRuntime(measured, minimalBashHarness);
    function step<T>(name: string, fn: () => T): T {
      const before = { transactions, reads, writes };
      const result = fn();
      segments.push({ name, transactions: transactions - before.transactions,
        reads: reads - before.reads, writes: writes - before.writes });
      return result;
    }
    const config = { provider: "openai", modelId: "gpt-5.6-sol",
      accountId: "11111111-1111-4111-8111-111111111111", machineId: "22222222-2222-4222-8222-222222222222", executionToken: `me1.22222222-2222-4222-8222-222222222222.1.${"x".repeat(43)}`, cwd: "/tmp" };
    step("initialize", () => runtime.initialize({ session: { sessionId: "test", harness: minimalBashHarness.identity }, config }));
    function process(name: string) {
      const plan = step(name + " prepare", () => runtime.prepareNext());
      if (!plan) throw new Error("Expected pending input");
      step(name + " commit", () => runtime.commit(plan, plan.operations.map(op => ({ operationId: op.operationId,
        result: { status: "accepted" as const, jobId: "job-" + op.operationId } }))));
    }
    const send = (id: string) => step(id + " admit", () => runtime.appendInput({ eventId: id,
      event: { type: "minimal_bash.message", payload: { message: { role: "user", content: [{ type: "text", text: id }] } } } }));
    const llm = (tools: boolean): OperationOutcome => ({ status: "succeeded", result: {
      gatewayJobId: "gateway-job", response: { id: "response-1", modelId: config.modelId,
        message: { role: "assistant", provider: "openai", content: tools
          ? [{ type: "function_call", id: "item-a", call_id: "call-a", name: "bash", arguments: '{"command":"pwd"}', status: "completed" }]
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }] },
        stopReason: tools ? "tool_use" : "stop", durationMs: 10, timestamp: 10, usage: { input: 2, output: 3 } },
    } });
    const bash: OperationOutcome = { status: "succeeded", result: { content: [{ type: "text", text: "ok" }],
      isError: false, details: { reason: "exited", exitCode: 0 } } };
    function complete(name: string, outcome: OperationOutcome) {
      const op = runtime.getPendingOperations()[0]!;
      step(name + " admit", () => runtime.acceptCompletion({ operationId: op.operationId, submissionId: op.operationId,
        provider: op.provider, jobId: op.jobId, outcome }));
      process(name);
    }
    send("user"); process("user"); complete("llm tools", llm(true)); complete("bash", bash); complete("llm final", llm(false));
    send("followup"); process("followup"); send("steering"); process("steering");
    complete("promote steering", llm(false)); complete("after steering", llm(false));
    return segments;
  }
}
export default {
  async fetch(_request: Request, env: { PROFILE: DurableObjectNamespace<StorageProfile> }) {
    return Response.json(await env.PROFILE.get(env.PROFILE.idFromName("profile")).run());
  },
};
