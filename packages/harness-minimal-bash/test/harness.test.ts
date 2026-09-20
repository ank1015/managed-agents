import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStorage, SqlStorageValue } from "@cloudflare/workers-types";
import { ContractException, parseJsonValue } from "@managed-agents/contracts";
import type { HarnessStatus, JsonValue, LlmInput, OperationOutcome, ProviderSubmission } from "@managed-agents/contracts";
import { SessionRuntime } from "@managed-agents/session-runtime";
import { minimalBashHarness, parseMinimalBashConfig, parseMinimalBashInput, readMinimalBashMessages, readMinimalBashState, readPendingMessages } from "../src/index.ts";
import { appendMessage } from "../src/state.ts";
import { buildLlmInput } from "../src/openai.ts";

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
  let status: HarnessStatus = "idle";
  const statuses: HarnessStatus[] = [];
  let runtime = new SessionRuntime(storage, minimalBashHarness);
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
  runtime.initialize({ session: { sessionId: "test-session", harness: minimalBashHarness.identity }, config });
  return { storage, get runtime() { return runtime; }, restart() { runtime = new SessionRuntime(storage, minimalBashHarness); },
    statuses, process, submitted,
    state: () => ({ ...readMinimalBashState(storage.sql), status }),
    page: () => readMinimalBashMessages(storage.sql),
    pending: () => readPendingMessages(storage.sql),
    send(id: string, type = "minimal_bash.message", payload: JsonValue = { message: { role: "user", content: [{ type: "text", text: id }] } }) {
      const receipt = runtime.appendInput({ eventId: id, event: { type, payload } }); process(); return receipt;
    },
    request() {
      const row = submitted.get(readMinimalBashState(storage.sql).activeOperationId!)!;
      return { operation_id: row.operationId, provider: row.request.provider,
        input: row.request.input as unknown as Exclude<LlmInput, { previousJobId: string }> };
    },
    complete(outcome: OperationOutcome) {
      const row = runtime.getPendingOperations().find(op => op.operationId === readMinimalBashState(storage.sql).activeOperationId)!;
      const value = { operationId: row.operationId, submissionId: row.operationId, provider: row.provider, jobId: row.jobId, outcome };
      const receipt = runtime.acceptCompletion(value); process(); return { value, receipt };
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
    assert.deepEqual(f.page().messages, []);
    f.send("first"); const first = f.request();
    assert.match(first.input.instructions!, /\/workspace/);
    assert.equal(first.input.messages.some(message => message.role === "system"), false);
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
    assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_pending_operations").one().n, 1);
    f.complete(assistant()); assert.equal(f.state().status, "idle");
    assert.deepEqual(f.statuses, ["running", "idle"]);
    assert.equal(f.page().messages.some(row => row.message.role === "custom"), false);
  } finally { f.storage.db.close(); }
});
test("message sequences survive rollback and restart without AUTOINCREMENT or a context index", () => {
  const f = fixture(); try {
    const message = { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] };
    assert.equal(appendMessage(f.storage.sql, message, null), 1);
    assert.throws(() => f.storage.transactionSync(() => {
      assert.equal(appendMessage(f.storage.sql, message, null), 2);
      throw new Error("rollback");
    }), /rollback/);
    f.restart();
    assert.equal(appendMessage(f.storage.sql, message, null), 2);
    f.send("next");
    assert.deepEqual(f.page().messages.map(row => row.sequence), [1, 2, 3]);
    assert.deepEqual(f.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('sqlite_sequence', 'minimal_bash_messages_context')").toArray(), []);
  } finally { f.storage.db.close(); }
});
test("context scans all history in order, then excludes messages in memory before its byte limit", () => {
  const f = fixture(); try {
    const first = { role: "user" as const, content: [{ type: "text" as const, text: "first" }] };
    const last = { role: "user" as const, content: [{ type: "text" as const, text: "last" }] };
    appendMessage(f.storage.sql, first, null);
    // Individually valid rows, but the excluded history exceeds the operation input budget in total.
    for (let i = 0; i < 9; i++) appendMessage(f.storage.sql,
      { role: "custom", tag: "excluded", data: "x".repeat(1_000_000) }, null, { inContext: false });
    appendMessage(f.storage.sql, last, null);
    const queries: string[] = [];
    const sql = { exec: (query: string, ...bindings: SqlStorageValue[]) => {
      queries.push(query); return f.storage.sql.exec(query, ...bindings);
    } } as Pick<SqlStorage, "exec">;
    const input = buildLlmInput(sql, parseMinimalBashConfig(config), "test-session") as unknown as { messages: unknown[] };
    assert.deepEqual(input.messages, [first, last]);
    assert.deepEqual(queries, ["SELECT message_json, in_context FROM minimal_bash_messages ORDER BY sequence"]);
    assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM minimal_bash_messages").one().n, 11);
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
    assert.deepEqual(f.runtime.acceptCompletion(value), { ...receipt, duplicate: true }); assert.equal(f.process().processed, false);
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
    assert.equal([...f.submitted.values()].filter(op => op.request.provider === "tool-pi-bash").length, 1);
  } finally { f.storage.db.close(); }
});
test("8 MiB input size limits commit failures rather than poison the inbox", () => {
  const f = fixture(); try {
    for (let i = 0; i < 9; i++) appendMessage(f.storage.sql, { role: "user", content: [{ type: "text", text: "x".repeat(1_000_000) }] }, null);
    f.send("large");
    assert.equal(f.state().status, "failed"); assert.equal(f.process().processed, false);
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
    const text = "x".repeat(1_000_000);
    for (let i = 0; i < 3; i++) appendMessage(f.storage.sql, { role: "user", content: [{ type: "text", text }] }, null);
    f.send("large", "minimal_bash.message", { message: { role: "user", content: [{ type: "text", text }] } });
    assert.equal(f.state().status, "running");
    assert.equal(f.request().input.providerOptions.max_output_tokens, 128_000);
    assert.deepEqual(f.request().input.messages.at(-1), { role: "user", content: [{ type: "text", text }] });
    assert.ok(JSON.stringify(f.request().input).length > 3_000_000);
    f.complete({ status: "failed", origin: "execution", error: { code: "context_length_exceeded", message: "Provider context exceeded" } });
    assert.equal(f.state().status, "failed"); assert.equal(f.state().activeOperationId, null);
    assert.equal(f.process().processed, false);
  } finally { f.storage.db.close(); }
});
test("large native assistant payload survives restart, transcript pagination and full replay", () => {
  const f = fixture(); try {
    f.send("one");
    const content = [{ type: "reasoning", id: "r-large", encrypted_content: "😀".repeat(440_000), summary: [] }, nativeCall("large-call")];
    f.complete(assistant(content)); f.restart();
    assert.equal(f.request().provider, "tool-pi-bash"); f.complete(bash());
    const replay = f.request().input.messages.find(m => m.role === "assistant")!;
    assert.deepEqual(replay.content, content);
    const first = readMinimalBashMessages(f.storage.sql, 0, 1); assert.notEqual(first.nextCursor, null);
    const next = readMinimalBashMessages(f.storage.sql, first.nextCursor!, 1);
    assert.equal(next.messages.length, 1); assert.deepEqual(next.messages[0]!.message, replay);
    assert.deepEqual(f.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE '%chunks%'").toArray(), []);
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
      assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_pending_operations").one().n, 1);
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
    assert.throws(() => f.process(), /injected/);
    assert.equal(f.page().messages.length, 0); assert.equal(f.pending().messages.length, 0);
    assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_pending_operations").one().n, 0);
    f.storage.db.exec("DROP TRIGGER fail_state");
    const processed = f.process();
    assert.ok(processed.processed); assert.equal(processed.status, "running");
  } finally { f.storage.db.close(); }
});
test("messages are cursor-paginated independently from pending admission order", () => {
  const f = fixture(); try {
    f.send("one"); f.send("two"); f.send("three");
    appendMessage(f.storage.sql, { role: "user", content: [{ type: "text", text: "page fixture" }] }, null);
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
    const first = f.page(); assert.equal(first.messages.length, 2); assert.equal(first.nextCursor, 2);
    const rest = readMinimalBashMessages(f.storage.sql, first.nextCursor!); assert.equal(rest.messages.length, 2); assert.equal(rest.nextCursor, null);
    const pending = f.pending(); assert.equal(pending.messages.length, 2); assert.equal(pending.nextCursor, 2);
    const remaining = readPendingMessages(f.storage.sql, pending.nextCursor!); assert.equal(remaining.messages.length, 2); assert.equal(remaining.nextCursor, null);
  } finally { f.storage.db.close(); }
});

test("planning a completion replays identical full context and promotes inline steering", () => {
  const f = fixture(); try {
    f.send("one");
    const message = { role: "user", content: [{ type: "text", text: "😀".repeat(300_000) }] };
    f.send("steer", "minimal_bash.message", { message });
    assert.deepEqual(f.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE '%chunks%'").toArray(), []);
    const row = f.runtime.getPendingOperations()[0]!;
    f.runtime.acceptCompletion({ operationId: row.operationId, submissionId: row.operationId, provider: row.provider,
      jobId: row.jobId, outcome: assistant() });
    const first = f.runtime.prepareNext()!;
    assert.equal(f.page().messages.length, 1); assert.equal(f.pending().messages.length, 1);
    f.restart(); const replay = f.runtime.prepareNext()!;
    assert.deepEqual(replay, first);
    const llm = replay.operations[0]!.request.input as unknown as Exclude<LlmInput, { previousJobId: string }>;
    assert.deepEqual(llm.messages.map(m => m.role), ["user", "assistant", "user"]);
    assert.deepEqual(llm.messages.at(-1), message);
    f.process(); assert.equal(f.pending().messages.length, 0);
    assert.deepEqual(f.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE '%chunks%'").toArray(), []);
    f.restart(); assert.deepEqual(f.page().messages.at(-1)!.message, message);
  } finally { f.storage.db.close(); }
});

test("oversized individual message fails the harness, consumes the input and never submits an operation", () => {
  const f = fixture(); try {
    // Fits the inbox's envelope budget, but not the harness message-row budget.
    const receipt = f.send("oversized", "minimal_bash.message", { message: { role: "user", content: [{ type: "text", text: "x".repeat(1_910_000) }] } });
    assert.equal(f.state().status, "failed");
    assert.equal((f.state().error as { code: string }).code, "MESSAGE_TOO_LARGE");
    assert.equal(f.state().activeOperationId, null);
    assert.equal(f.page().messages.length, 0); assert.equal(f.submitted.size, 0);
    assert.equal(f.process().processed, false);
    assert.equal(f.storage.sql.exec<{ event_json: null }>("SELECT event_json FROM runtime_inbox").one().event_json, null);
    assert.equal(receipt.duplicate, false);
  } finally { f.storage.db.close(); }
});

test("oversized steering fails cleanly and an old accepted job cannot poison a resumed run", () => {
  const f = fixture(); try {
    f.send("first");
    const old = f.runtime.getPendingOperations()[0]!;
    f.send("oversized-steering", "minimal_bash.message", { message: { role: "user", content: [{ type: "text", text: "x".repeat(1_910_000) }] } });
    assert.equal(f.state().status, "failed"); assert.equal(f.pending().messages.length, 0);
    assert.equal((f.state().error as { code: string }).code, "MESSAGE_TOO_LARGE");
    f.send("resume", "minimal_bash.resume", {});
    const current = f.state().activeOperationId;
    assert.notEqual(current, old.operationId);
    f.runtime.acceptCompletion({ operationId: old.operationId, submissionId: old.operationId,
      provider: old.provider, jobId: old.jobId, outcome: assistant([nativeCall("must-not-execute")]) });
    f.process();
    assert.equal(f.state().activeOperationId, current); assert.equal(f.state().status, "running");
    assert.deepEqual(f.page().messages.map(row => row.message.role), ["user"]);
    assert.equal(f.runtime.getPendingOperations().some(row => row.operationId === old.operationId), false);
    f.complete(assistant()); assert.equal(f.state().status, "idle");
  } finally { f.storage.db.close(); }
});
