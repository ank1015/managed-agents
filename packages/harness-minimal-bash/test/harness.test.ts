import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import { ContractException, parseJsonValue } from "@managed-agents/contracts";
import type { JsonValue, LlmInput, OperationOutcome } from "@managed-agents/contracts";
import { SessionRuntime } from "@managed-agents/session-runtime";
import { minimalBashHarness, parseMinimalBashConfig, parseMinimalBashInput, readMinimalBashMessages, readMinimalBashState, readPendingMessages } from "../src/index.ts";
import { appendMessage } from "../src/state.ts";
import { readJson } from "@managed-agents/sqlite-json";

const config = { provider: "openai", modelId: "gpt-5.6-sol", accountId: "11111111-1111-4111-8111-111111111111", machineId: "22222222-2222-4222-8222-222222222222", cwd: "/workspace" };
class Storage {
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
function fixture() {
  const storage = new Storage();
  let runtime = new SessionRuntime(storage, minimalBashHarness);
  runtime.initialize({ session: { sessionId: "test-session", harness: minimalBashHarness.identity }, config });
  return { storage, get runtime() { return runtime; }, restart() { runtime = new SessionRuntime(storage, minimalBashHarness); },
    state: () => readMinimalBashState(storage.sql),
    page: () => readMinimalBashMessages(storage.sql),
    pending: () => readPendingMessages(storage.sql),
    send(id: string, type = "minimal_bash.message", payload: JsonValue = { message: { role: "user", content: [{ type: "text", text: id }] } }) {
      const receipt = runtime.appendInput({ eventId: id, event: { type, payload } }); runtime.processNext(); return receipt;
    },
    request() {
      const row = storage.sql.exec<{ operation_id: string; provider: string; input_json: string }>(`SELECT o.operation_id, o.provider, b.input_json FROM runtime_operations o
        JOIN runtime_outbox b ON b.operation_id = o.operation_id WHERE o.operation_id = ?`, readMinimalBashState(storage.sql).activeOperationId).one();
      return { ...row, input: readJson<Exclude<LlmInput, { previousJobId: string }>>(storage.sql, "runtime_json_chunks", row.input_json) };
    },
    complete(outcome: OperationOutcome) {
      const row = storage.sql.exec<{ operation_id: string; submission_id: string; provider: string }>("SELECT * FROM runtime_operations WHERE operation_id = ?", readMinimalBashState(storage.sql).activeOperationId).one();
      const value = { operationId: row.operation_id, submissionId: row.submission_id, provider: row.provider, jobId: `job-${row.operation_id}`, outcome };
      const receipt = runtime.acceptCompletion(value); runtime.processNext(); return { value, receipt };
    },
  };
}
const nativeCall = (id: string, args: unknown = { command: "pwd" }) => ({ type: "function_call", id: `item-${id}`, call_id: id, name: "bash", arguments: typeof args === "string" ? args : JSON.stringify(args), status: "completed" });
const assistant = (content: JsonValue[] = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }], stopReason = content.some(item => item && typeof item === "object" && !Array.isArray(item) && item.type === "function_call") ? "tool_use" : "stop"): OperationOutcome => ({
  status: "succeeded", result: { gatewayJobId: "gateway-job", response: { id: "response-1", modelId: config.modelId,
    message: { role: "assistant", provider: "openai", content, metadata: { preserved: true } }, stopReason, durationMs: 10, timestamp: 10,
    usage: { input: 2, output: 3 } } },
});
const bash = (isError = false): OperationOutcome => ({ status: "succeeded", result: { content: [{ type: "text", text: isError ? "Command exited with code 1" : "ok" }], isError, details: { reason: "exited", exitCode: isError ? 1 : 0, fullOutputPath: "/tmp/output" } } });

test("configuration defaults medium, validates the catalog and rejects unknown routing/settings", () => {
  assert.equal(parseMinimalBashConfig(config).reasoning, "medium");
  for (const reasoning of ["low", "medium", "high", "xhigh", "max"]) assert.equal(parseMinimalBashConfig({ ...config, reasoning }).reasoning, reasoning);
  for (const patch of [{ provider: "chatgpt" }, { modelId: "unknown" }, { reasoning: "off" }, { reasoning: null }, { reasoning: "ultra" }, { accountId: "bad" }, { machineId: "bad" }, { cwd: "relative" }, { temperature: 1 }, { callbackUrl: "https://example.com" }]) {
    assert.throws(() => parseMinimalBashConfig({ ...config, ...patch }), (e: unknown) => e instanceof ContractException && e.code === "INVALID_CONFIG");
  }
});
test("input validation preserves full user messages and rejects follow-ups or fabricated roles", () => {
  const event = { type: "minimal_bash.message", payload: { message: { role: "user", id: "x", timestamp: 12, metadata: { a: 1 }, content: [{ type: "text", text: "hi" }, { type: "image", url: "https://example.com/image.png" }] } } };
  assert.deepEqual(parseMinimalBashInput(parseJsonValue(event) as never), event);
  for (const value of [{ ...event, payload: { ...event.payload, delivery: "follow_up" } }, { type: "minimal_bash.follow_up", payload: {} },
    ...["system", "assistant", "custom", "tool_result"].map(role => ({ ...event, payload: { message: { role, content: [] } } })),
    { type: "minimal_bash.cancel", payload: {} }, { type: "minimal_bash.resume", payload: { force: true } }]) assert.throws(() => parseMinimalBashInput(parseJsonValue(value) as never));
});
test("full native messages replay unchanged; lifecycle entries never reach LLM input", () => {
  const f = fixture();
  try {
    f.send("first"); const first = f.request();
    assert.equal(first.input.previousJobId, null); assert.equal(first.input.accountId, config.accountId);
    assert.deepEqual(first.input.providerOptions.reasoning, { effort: "medium", summary: "auto" });
    assert.equal(first.input.providerOptions.store, false); assert.equal(first.input.providerOptions.parallel_tool_calls, false);
    assert.equal(first.input.providerOptions.temperature, undefined); assert.equal(first.input.tools[0]?.name, "bash");
    const outcome = assistant([{ type: "reasoning", id: "r", encrypted_content: "opaque", summary: [] }, nativeCall("call-1")]);
    f.complete(outcome); assert.equal(f.request().provider, "tool-pi-bash");
    assert.deepEqual(f.request().input, { command: "pwd", cwd: config.cwd, machineId: config.machineId });
    f.complete(bash());
    const replay = f.request().input.messages;
    assert.deepEqual(replay.find(m => m.role === "assistant"), (outcome as unknown as { result: { response: { message: unknown } } }).result.response.message);
    assert.equal(replay.at(-1)?.role, "tool_result"); assert.ok(replay.every(m => m.role !== "custom"));
    assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_outbox").one().n, 1);
    f.complete(assistant()); assert.equal(f.state().status, "idle");
    assert.ok(f.page().messages.some(row => row.message.role === "custom" && !row.inContext));
  } finally { f.storage.db.close(); }
});
test("all steering drains together after the entire serial tool batch, including messages sent during LLM", () => {
  const f = fixture();
  try {
    f.send("first"); f.send("steer-1"); f.complete(assistant([nativeCall("one"), nativeCall("two", { command: "ls", timeout: 5 })]));
    f.send("steer-2"); assert.equal(f.state().pendingMessageCount, 2);
    f.complete(bash()); assert.equal(f.request().provider, "tool-pi-bash"); assert.equal(f.state().pendingMessageCount, 2);
    f.restart(); f.complete(bash());
    const messages = f.request().input.messages;
    assert.deepEqual(messages.slice(-2).map(m => m.role === "user" && m.content), [[{ type: "text", text: "steer-1" }], [{ type: "text", text: "steer-2" }]]);
    assert.equal(f.state().pendingMessageCount, 0);
    assert.deepEqual(messages.filter(m => m.role === "tool_result").map(m => m.toolCallId), ["one", "two"]);
    f.complete(assistant()); assert.equal(f.state().status, "idle");
  } finally { f.storage.db.close(); }
});
test("a final response still incorporates all queued steering before becoming idle", () => {
  const f = fixture(); try {
    f.send("first"); f.send("second"); f.send("third"); f.complete(assistant());
    assert.equal(f.state().status, "running"); assert.equal(f.state().turnCount, 2); assert.equal(f.state().pendingMessageCount, 0);
    assert.deepEqual(f.request().input.messages.slice(-2).map(m => m.role), ["user", "user"]);
  } finally { f.storage.db.close(); }
});
for (const cancelDuring of ["llm", "bash"]) test(`stop after turn during ${cancelDuring} finishes ALL calls, holds steering and resumes explicitly`, () => {
  const f = fixture(); try {
    f.send("first"); const runId = f.state().runId!;
    if (cancelDuring === "llm") f.send("cancel", "minimal_bash.cancel", { runId });
    f.complete(assistant([nativeCall("one"), nativeCall("two")]));
    if (cancelDuring === "bash") f.send("cancel", "minimal_bash.cancel", { runId });
    f.send("held"); assert.equal(f.state().status, "cancelling");
    f.complete(bash()); assert.equal(f.request().provider, "tool-pi-bash");
    f.complete(bash()); assert.equal(f.state().status, "cancelled"); assert.equal(f.state().activeOperationId, null); assert.equal(f.state().pendingMessageCount, 1);
    f.send("also-held"); assert.equal(f.state().status, "cancelled");
    f.send("resume", "minimal_bash.resume", {}); assert.equal(f.state().status, "running"); assert.notEqual(f.state().runId, runId);
    assert.equal(f.state().pendingMessageCount, 0); assert.ok(f.request().input.messages.every(m => m.role !== "custom"));
    f.send("stale-cancel", "minimal_bash.cancel", { runId }); assert.equal(f.state().status, "running");
  } finally { f.storage.db.close(); }
});
test("cancellation of a text-only LLM turn stops without consuming steering", () => {
  const f = fixture(); try {
    f.send("one"); f.send("stop", "minimal_bash.cancel", { runId: f.state().runId! }); f.send("held");
    f.complete(assistant()); assert.equal(f.state().status, "cancelled"); assert.equal(f.pending().messages.length, 1);
  } finally { f.storage.db.close(); }
});
test("input and completion retries cannot duplicate transcript rows or operations", () => {
  const f = fixture(); try {
    f.send("one"); assert.equal(f.send("one").duplicate, true);
    const { value, receipt } = f.complete(assistant()); const count = f.page().messages.length;
    assert.deepEqual(f.runtime.acceptCompletion(value), { ...receipt, duplicate: true }); assert.equal(f.runtime.processNext().processed, false);
    assert.equal(f.page().messages.length, count);
    assert.throws(() => f.send("one", "minimal_bash.message", { message: { role: "user", content: [{ type: "text", text: "changed" }] } }));
  } finally { f.storage.db.close(); }
});
test("malformed bash arguments become tool errors and do not execute; command failures remain model-visible", () => {
  const f = fixture(); try {
    f.send("one"); f.complete(assistant([nativeCall("bad", "{"), nativeCall("override", { command: "ls", machineId: "evil" }), nativeCall("valid")]));
    assert.equal(f.request().provider, "tool-pi-bash");
    assert.equal(f.page().messages.filter(row => row.message.role === "tool_result").length, 2);
    f.complete(bash(true)); assert.equal(f.request().provider, "llm");
    const last = f.request().input.messages.at(-1)!; assert.equal(last.role, "tool_result");
    if (last.role === "tool_result") assert.equal(last.outcome.status, "error");
  } finally { f.storage.db.close(); }
});
for (const kind of ["length", "unknown-tool", "duplicate-id", "wrong-provider", "wrong-model", "malformed"]) test(`unsafe LLM response ${kind} fails without executing or entering context`, () => {
  const f = fixture(); try {
    f.send("one");
    const result = assistant([nativeCall("one")]) as { status: "succeeded"; result: { gatewayJobId: string; response: { message: { provider: string; content: JsonValue[] }; modelId: string; stopReason: string } } };
    if (kind === "length") result.result.response.stopReason = "length";
    if (kind === "unknown-tool") result.result.response.message.content = [{ ...nativeCall("one"), name: "remove" }];
    if (kind === "duplicate-id") result.result.response.message.content.push(nativeCall("one"));
    if (kind === "wrong-provider") result.result.response.message.provider = "chatgpt";
    if (kind === "wrong-model") result.result.response.modelId = "gpt-5.6-luna";
    if (kind === "malformed") result.result.response.message.content = [null];
    f.complete(result); assert.equal(f.state().status, "failed"); assert.equal(f.state().activeOperationId, null);
    assert.equal(f.page().messages.filter(row => row.message.role === "assistant" && row.inContext).length, 0);
    f.send("resume", "minimal_bash.resume", {}); assert.ok(f.request().input.messages.every(m => m.role !== "assistant"));
  } finally { f.storage.db.close(); }
});
test("unknown bash outcomes stop, close remaining calls, and never resubmit the command", () => {
  const f = fixture(); try {
    f.send("one"); f.complete(assistant([nativeCall("one"), nativeCall("two")]));
    f.complete({ status: "failed", origin: "execution", error: { code: "BASH_EXECUTION_UNKNOWN", message: "May have run" } });
    assert.equal(f.state().status, "failed"); assert.equal(f.page().messages.filter(row => row.message.role === "tool_result").length, 2);
    f.send("resume", "minimal_bash.resume", {}); assert.equal(f.request().provider, "llm");
    assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_operations WHERE provider = 'tool-pi-bash'").one().n, 1);
  } finally { f.storage.db.close(); }
});
test("8 MiB input size limits commit failures rather than poison the inbox", () => {
  const f = fixture(); try {
    f.send("large", "minimal_bash.message", { message: { role: "user", content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] } });
    assert.equal(f.state().status, "failed"); assert.equal(f.runtime.processNext().processed, false);
    assert.equal((f.state().error as { code: string }).code, "OPERATION_INPUT_TOO_LARGE");
    assert.equal(f.state().activeOperationId, null);
  } finally { f.storage.db.close(); }
});
test("runs continue beyond 100 model turns without requiring resume", () => {
  const f = fixture(); try {
    f.send("one"); const runId = f.state().runId;
    for (let i = 0; i < 105; i++) {
      f.complete(assistant([nativeCall(`turn-${i}`)])); f.complete(bash());
      assert.equal(f.state().status, "running"); assert.equal(f.state().runId, runId);
      assert.equal(f.request().provider, "llm");
    }
    assert.equal(f.state().turnCount, 106);
    f.complete(assistant()); assert.equal(f.state().status, "idle");
  } finally { f.storage.db.close(); }
});
test("large context is submitted without a byte-to-token estimate; provider rejection fails the run", () => {
  const f = fixture(); try {
    const text = "x".repeat(3 * 1024 * 1024);
    f.send("large", "minimal_bash.message", { message: { role: "user", content: [{ type: "text", text }] } });
    assert.equal(f.state().status, "running");
    assert.equal(f.request().input.providerOptions.max_output_tokens, 128_000);
    assert.deepEqual(f.request().input.messages.at(-1), { role: "user", content: [{ type: "text", text }] });
    f.complete({ status: "failed", origin: "execution", error: { code: "context_length_exceeded", message: "Provider context exceeded" } });
    assert.equal(f.state().status, "failed"); assert.equal(f.state().activeOperationId, null);
    assert.equal(f.runtime.processNext().processed, false);
  } finally { f.storage.db.close(); }
});
test("large native assistant payload survives restart, transcript pagination and full replay", () => {
  const f = fixture(); try {
    f.send("one");
    const content = [{ type: "reasoning", id: "r-large", encrypted_content: "😀".repeat(800_000), summary: [] }, nativeCall("large-call")];
    f.complete(assistant(content)); f.restart();
    assert.equal(f.request().provider, "tool-pi-bash"); f.complete(bash());
    const replay = f.request().input.messages.find(m => m.role === "assistant")!;
    assert.deepEqual(replay.content, content);
    const first = f.page(); assert.notEqual(first.nextCursor, null);
    const next = readMinimalBashMessages(f.storage.sql, first.nextCursor!);
    assert.equal(next.messages.length, 1); assert.deepEqual(next.messages[0]!.message, replay);
    f.complete(assistant()); assert.equal(f.state().status, "idle");
  } finally { f.storage.db.close(); }
});
test("responses with more than 64 bash calls execute every call serially", () => {
  const f = fixture(); try {
    const calls = Array.from({ length: 65 }, (_, i) => nativeCall(`call-${i}`, { command: `echo ${i}` }));
    f.send("one"); f.complete(assistant(calls));
    for (let i = 0; i < calls.length; i++) {
      const request = f.request();
      assert.equal(request.provider, "tool-pi-bash");
      assert.deepEqual(request.input, { command: `echo ${i}`, cwd: config.cwd, machineId: config.machineId });
      assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_outbox").one().n, 1);
      f.complete(bash());
    }
    assert.equal(f.request().provider, "llm");
    assert.deepEqual(f.request().input.messages.filter(m => m.role === "tool_result").map(m => m.toolCallId), calls.map(c => c.call_id));
    f.complete(assistant()); assert.equal(f.state().status, "idle");
  } finally { f.storage.db.close(); }
});
test("state, promoted messages and requested operations roll back together", () => {
  const f = fixture(); try {
    f.runtime.appendInput({ eventId: "one", event: { type: "minimal_bash.message", payload: { message: { role: "user", content: [{ type: "text", text: "one" }] } } } });
    f.storage.db.exec("CREATE TRIGGER fail_state BEFORE UPDATE ON minimal_bash_state BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.throws(() => f.runtime.processNext(), /injected/);
    assert.equal(f.page().messages.length, 1); assert.equal(f.pending().messages.length, 0);
    assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_operations").one().n, 0);
    f.storage.db.exec("DROP TRIGGER fail_state"); f.runtime.processNext(); assert.equal(f.state().status, "running");
  } finally { f.storage.db.close(); }
});
test("messages are cursor-paginated independently from pending admission order", () => {
  const f = fixture(); try {
    f.send("one"); f.send("two"); f.send("three");
    const first = readMinimalBashMessages(f.storage.sql, 0, 1); assert.equal(first.messages.length, 1); assert.equal(first.nextCursor, 1);
    assert.equal(readMinimalBashMessages(f.storage.sql, first.nextCursor!, 100).messages[0]!.sequence, 2);
    const pending = readPendingMessages(f.storage.sql, 0, 1); assert.equal(pending.messages[0]!.eventId, "two");
    assert.equal(readPendingMessages(f.storage.sql, pending.nextCursor!, 1).messages[0]!.eventId, "three");
  } finally { f.storage.db.close(); }
});
test("large transcript and pending pages stop at a byte budget without dropping messages", () => {
  const f = fixture(); try {
    const message = { role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(800_000) }] };
    for (let i = 1; i <= 4; i++) {
      appendMessage(f.storage.sql, message, null);
      f.storage.sql.exec("INSERT INTO minimal_bash_pending_messages VALUES (?, ?, ?)", `large-${i}`, i, JSON.stringify(message)).toArray();
    }
    const first = f.page(); assert.equal(first.messages.length, 3); assert.equal(first.nextCursor, 3);
    const rest = readMinimalBashMessages(f.storage.sql, first.nextCursor!); assert.equal(rest.messages.length, 2); assert.equal(rest.nextCursor, null);
    const pending = f.pending(); assert.equal(pending.messages.length, 2); assert.equal(pending.nextCursor, 2);
    const remaining = readPendingMessages(f.storage.sql, pending.nextCursor!); assert.equal(remaining.messages.length, 2); assert.equal(remaining.nextCursor, null);
  } finally { f.storage.db.close(); }
});
