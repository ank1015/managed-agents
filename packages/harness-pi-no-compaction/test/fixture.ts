import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStorage, SqlStorageValue } from "@cloudflare/workers-types";
import { ContractException, parseJsonValue } from "@managed-agents/contracts";
import type { HarnessStatus, JsonValue, LlmInput, OperationOutcome, ProviderSubmission } from "@managed-agents/contracts";
import { SessionRuntime } from "@managed-agents/session-runtime";
import { piNoCompactionHarness, parsePiNoCompactionConfig, parsePiNoCompactionInput, readPiNoCompactionMessages, readPiNoCompactionState, readPendingMessages } from "../src/index.ts";
import { appendMessage } from "../src/state.ts";
import { buildLlmInput, toolCalls } from "../src/llm.ts";

export const config = { provider: "openai", modelId: "gpt-5.6-sol", accountId: "11111111-1111-4111-8111-111111111111", machineId: "22222222-2222-4222-8222-222222222222", executionGatewayUrl: "https://gateway.test", executionToken: `me1.22222222-2222-4222-8222-222222222222.1.${"x".repeat(43)}`, cwd: "/workspace" };
export class Storage {
  db = new DatabaseSync(":memory:");
  sql = { exec: (query: string, ...bindings: SQLInputValue[]) => {
    const rows = this.db.prepare(query).all(...bindings);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  constructor() { this.db.exec("PRAGMA foreign_keys = ON"); }
  transactionSync<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT harness_test");
    try { const result = fn(); this.db.exec("RELEASE harness_test"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO harness_test; RELEASE harness_test"); throw error; }
  }
}
export function fixture(overrides: Record<string, JsonValue> = {}) {
  const storage = new Storage();
  let status: HarnessStatus = "idle";
  const statuses: HarnessStatus[] = [];
  let runtime = new SessionRuntime(storage, piNoCompactionHarness);
  const submitted = new Map<string, ProviderSubmission>();
  function process() {
    const plan = runtime.prepareNext();
    if (!plan) return { processed: false as const };
    for (const op of plan.operations) submitted.set(op.operationId, op);
    const result = runtime.commit(plan, plan.operations.map(op => ({ operationId: op.operationId,
      result: { status: "accepted" as const, jobId: `job-${op.operationId}` } })));
    if (result.processed && result.status) { status = result.status; statuses.push(status); }
    return result;
  }
  runtime.initialize({ session: { sessionId: "test-session", harness: piNoCompactionHarness.identity }, config: { ...config, ...overrides } });
  return { storage, get runtime() { return runtime; }, restart() { runtime = new SessionRuntime(storage, piNoCompactionHarness); },
    statuses, process, submitted,
    state: () => ({ ...readPiNoCompactionState(storage.sql), status }),
    page: () => readPiNoCompactionMessages(storage.sql),
    pending: () => readPendingMessages(storage.sql),
    send(id: string, type = "pi_no_compaction.message", payload: JsonValue = { message: { role: "user", content: [{ type: "text", text: id }] } }) {
      const receipt = runtime.appendInput({ eventId: id, event: { type, payload } }); process(); return receipt;
    },
    request() {
      const row = submitted.get(readPiNoCompactionState(storage.sql).activeOperationId!)!;
      return { operation_id: row.operationId, provider: row.request.provider,
        input: row.request.input as unknown as Exclude<LlmInput, { previousJobId: string }> };
    },
    complete(outcome: OperationOutcome, id = readPiNoCompactionState(storage.sql).activeOperationId!) {
      const row = runtime.getPendingOperations().find(op => op.operationId === id)!;
      const value = { operationId: row.operationId, submissionId: row.operationId, provider: row.provider, jobId: row.jobId, outcome };
      const receipt = runtime.acceptCompletion(value); process(); return { value, receipt };
    },
  };
}
export const nativeCall = (id: string, args: unknown = { command: "pwd" }, name = "bash") => ({ type: "function_call", id: `item-${id}`, call_id: id, name, arguments: typeof args === "string" ? args : JSON.stringify(args), status: "completed" });
export const assistant = (content: JsonValue[] = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }], stopReason = content.some(item => item && typeof item === "object" && !Array.isArray(item) && item.type === "function_call") ? "tool_use" : "stop"): OperationOutcome => ({
  status: "succeeded", result: { gatewayJobId: "gateway-job", response: { id: "response-1", modelId: config.modelId,
    message: { role: "assistant", provider: "openai", content, metadata: { preserved: true } }, stopReason, durationMs: 10, timestamp: 10,
    usage: { input: 2, output: 3 } } },
});
export const bash = (isError = false): OperationOutcome => ({ status: "succeeded", result: { content: [{ type: "text", text: isError ? "Command exited with code 1" : "ok" }], isError, details: { reason: "exited", exitCode: isError ? 1 : 0, fullOutputPath: "/tmp/output" } } });


export function active(f: ReturnType<typeof fixture>, callId: string) {
  const message = f.page().messages.map(row => row.message).reverse().find(message => message.role === "assistant");
  assert.ok(message?.role === "assistant");
  const index = toolCalls(message).findIndex(call => call.callId === callId);
  const row = f.runtime.getPendingOperations().find(op => op.key === `tool:${index}`);
  assert.ok(row, `Missing active call ${callId}`); return row.operationId;
}
export const fireworksModel = "accounts/fireworks/models/kimi-k3";
export function fireworks(calls: { id: string; name: string; arguments: string }[] = []): OperationOutcome {
  return { status: "succeeded", result: { gatewayJobId: "fw-job", response: {
    id: "fw-response", modelId: fireworksModel, durationMs: 1, timestamp: 1, stopReason: calls.length ? "tool_use" : "stop",
    message: { role: "assistant", provider: "fireworks", content: [{ role: "assistant", content: calls.length ? null : "done",
      reasoning_content: "native reasoning", extra_provider_field: { opaque: true },
      ...(calls.length ? { tool_calls: calls.map(({ id, name, arguments: args }) => ({ id, type: "function", function: { name, arguments: args } })) } : {}) }] }
  } } };
}
