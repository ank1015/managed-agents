import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonValue } from "@managed-agents/contracts";
import type { JsonValue, OperationOutcome } from "@managed-agents/contracts";
import { parsePiNoCompactionConfig, parsePiNoCompactionInput, FIREWORKS_MODELS, OPENAI_MODELS, createInstructions } from "../src/index.ts";
import { buildLlmInput, toolCalls } from "../src/llm.ts";
import { appendMessage } from "../src/state.ts";
import { fixture, config, nativeCall, assistant, bash, active, fireworks, fireworksModel } from "./fixture.ts";

const fileResult = (text = "ok", isError = false): OperationOutcome => ({ status: "succeeded", result: {
  content: [{ type: "text", text }], isError, details: { gatewayJobId: "job", path: "/workspace/file" },
} });
const write = (id: string, path = "file") => nativeCall(id, { path, content: "new" }, "write");
const edit = (id: string, path = "file") => nativeCall(id, { path, edits: [{ oldText: "old", newText: "new" }] }, "edit");
const read = (id: string, path = "file") => nativeCall(id, { path }, "read");

test("both providers share reasoning levels/defaults, immutable catalog excludes nonvision models", () => {
  for (const [provider, models] of Object.entries({ openai: OPENAI_MODELS, fireworks: FIREWORKS_MODELS })) {
    for (const modelId of Object.keys(models)) {
      assert.equal(parsePiNoCompactionConfig({ ...config, provider, modelId }).reasoning, "medium");
      for (const reasoning of ["low", "medium", "high", "xhigh", "max"]) {
        assert.equal(parsePiNoCompactionConfig({ ...config, provider, modelId, reasoning }).reasoning, reasoning);
      }
    }
  }
  for (const patch of [{ provider: "chatgpt" }, { provider: "fireworks" }, { provider: "fireworks", modelId: "accounts/fireworks/models/glm-5p3" },
    { reasoning: null }, { reasoning: "none" }, { reasoning: "default" }, { accountId: "bad" }, { cwd: "relative" },
    { cwd: "/bad\0path" }, { maxOutputTokens: 0 }, { maxOutputTokens: 128001 }, { maxOutputTokens: 1.5 }, { maxOutputTokens: null }, { temperature: 1 }]) {
    assert.throws(() => parsePiNoCompactionConfig(parseJsonValue({ ...config, ...patch })));
  }
  assert.equal(parsePiNoCompactionConfig(config).maxOutputTokens, 128000);
  assert.equal(parsePiNoCompactionConfig({ ...config, provider: "fireworks", modelId: fireworksModel }).maxOutputTokens, 32768);
});
test("input preserves user images/metadata and rejects fabricated roles or unknown events", () => {
  const input = { type: "pi_no_compaction.message", payload: { message: { role: "user", metadata: { id: "original" }, content: [
    { type: "text", text: "look" }, { type: "image", url: "https://example.com/i.png" },
  ] } } };
  assert.deepEqual(parsePiNoCompactionInput(input), input);
  for (const role of ["system", "assistant", "tool_result", "custom"]) assert.throws(() => parsePiNoCompactionInput({ ...input, payload: { message: { ...input.payload.message, role } } }));
  assert.throws(() => parsePiNoCompactionInput({ type: "pi_no_compaction.follow_up", payload: {} }));
});
test("prompt and four-tool declarations contain only the selected base harness features", () => {
  const f = fixture(); try {
    f.send("go"); const input = f.request().input;
    assert.deepEqual(input.tools.map(t => t.name), ["read", "bash", "edit", "write"]);
    assert.equal(input.previousJobId, null); assert.equal(input.providerOptions.parallel_tool_calls, true);
    assert.deepEqual(input.providerOptions.reasoning, { effort: "medium", summary: "auto" });
    assert.deepEqual(input.providerOptions.include, ["reasoning.encrypted_content"]);
    assert.equal(input.providerOptions.store, false);
    assert.equal(input.instructions, createInstructions(config));
    assert.doesNotMatch(input.instructions!, /PI_\*|AGENTS\.md|<skills>|<docs>|extensions|compaction/i);
    assert.equal(input.messages.some(m => m.role === "system"), false);
  } finally { f.storage.db.close(); }
});
test("parallel mixed batch persists out-of-order results; all steering enters the next turn in order", () => {
  const f = fixture(); try {
    f.send("go"); f.send("steer1");
    f.complete(assistant([nativeCall("b"), read("r"), write("w"), edit("e"), read("r2")]));
    assert.equal(f.runtime.getPendingOperations().length, 4);
    f.complete(fileResult(), active(f, "r2")); f.complete(fileResult(), active(f, "r"));
    assert.equal(f.page().messages.filter(m => m.message.role === "tool_result").length, 0);
    f.send("steer2"); f.restart();
    f.complete(fileResult(), active(f, "w"));
    assert.equal(f.submitted.get(active(f, "e"))!.request.provider, "tool-pi-edit");
    f.complete(fileResult(), active(f, "e"));
    assert.equal(f.state().pendingMessageCount, 2); assert.equal(f.state().phase, "tools");
    f.complete(bash(), active(f, "b"));
    const messages = f.request().input.messages;
    assert.deepEqual(messages.filter(m => m.role === "tool_result").map(m => m.toolCallId), ["b", "r", "w", "e", "r2"]);
    assert.deepEqual(messages.slice(-2).map(m => m.role !== "custom" && m.content), [[{ type: "text", text: "steer1" }], [{ type: "text", text: "steer2" }]]);
    assert.equal(f.state().pendingMessageCount, 0);
    assert.equal(f.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pi_no_compaction_batch").one().n, 0);
    f.complete(assistant()); assert.equal(f.state().phase, "idle");
  } finally { f.storage.db.close(); }
});
test("mutation lane preserves original ordering even for aliases and different textual paths", () => {
  const f = fixture(); try {
    f.send("go"); f.complete(assistant([write("w", "dir/../file"), edit("e", "/workspace/file"), write("alias", "symlink"), write("other", "other")]));
    for (const id of ["w", "e", "alias", "other"]) {
      assert.equal(f.runtime.getPendingOperations().length, 1);
      const op = active(f, id);
      f.restart(); f.complete(fileResult(), op);
    }
    assert.equal(f.state().phase, "llm");
  } finally { f.storage.db.close(); }
});
test("Fireworks native reasoning and image tool results replay unchanged through a complete loop", () => {
  const f = fixture({ provider: "fireworks", modelId: fireworksModel, reasoning: "max" }); try {
    f.send("go"); const options = f.request().input.providerOptions;
    assert.deepEqual(options, { reasoning_effort: "max", max_tokens: 32768, prompt_cache_key: "test-session", tool_choice: "auto", parallel_tool_calls: true, context_length_exceeded_behavior: "error" });
    const outcome = fireworks([{ id: "image", name: "read", arguments: '{"path":"image.png"}' }]);
    f.complete(outcome);
    const imageContent = [{ type: "text", text: "Read image" }, { type: "image", url: "https://images.example.com/a", detail: "original" }];
    f.complete({ status: "succeeded", result: { content: imageContent, isError: false, details: { image: { id: "a" } } } }, active(f, "image"));
    const replay = f.request().input.messages;
    const original = (outcome as unknown as { result: { response: { message: unknown } } }).result.response.message;
    assert.deepEqual(replay.find(m => m.role === "assistant"), original);
    assert.deepEqual((replay.at(-1) as { content: unknown }).content, imageContent);
    f.complete(fireworks()); assert.equal(f.state().phase, "idle");
  } finally { f.storage.db.close(); }
});
test("expected tool errors and invalid arguments are model-visible and do not stop siblings", () => {
  const f = fixture(); try {
    f.send("go"); f.complete(assistant([nativeCall("bad", '{oops'), read("missing"), nativeCall("routing", { path: "a", machineId: config.machineId }, "read"), edit("ambiguous")]));
    assert.equal(f.runtime.getPendingOperations().length, 2);
    f.complete(fileResult("not found", true), active(f, "missing"));
    f.complete(fileResult("ambiguous", true), active(f, "ambiguous"));
    const results = f.request().input.messages.filter(m => m.role === "tool_result");
    assert.equal(results.length, 4); assert.ok(results.every(m => m.outcome.status === "error"));
    assert.equal(f.state().phase, "llm");
  } finally { f.storage.db.close(); }
});
test("unknown mutation outcome waits for active siblings, skips queued mutations, then allows resume", () => {
  const f = fixture(); try {
    f.send("go"); f.complete(assistant([write("w"), edit("e"), nativeCall("b"), read("r")]));
    f.complete({ status: "failed", origin: "execution", error: { code: "WRITE_OUTCOME_UNKNOWN", message: "unknown" } }, active(f, "w"));
    assert.equal(f.state().phase, "tools"); assert.equal(f.state().activeToolCount, 2);
    f.send("held"); f.send("ignored-resume", "pi_no_compaction.resume", {});
    assert.equal(f.state().phase, "tools");
    f.restart(); f.complete(fileResult(), active(f, "r")); f.complete(bash(), active(f, "b"));
    assert.equal(f.state().phase, "failed"); assert.equal(f.state().activeToolCount, 0);
    assert.equal(f.runtime.getPendingOperations().length, 0);
    const skipped = f.page().messages.map(m => m.message).find(m => m.role === "tool_result" && m.toolCallId === "e");
    assert.ok(skipped?.role === "tool_result" && skipped.outcome.status === "error");
    f.send("resume", "pi_no_compaction.resume", {});
    assert.equal(f.state().phase, "llm"); assert.equal(f.state().pendingMessageCount, 0);
  } finally { f.storage.db.close(); }
});
test("soft cancellation drains the entire batch including queued mutations and holds steering", () => {
  const f = fixture(); try {
    f.send("go"); const runId = f.state().runId!;
    f.send("cancel", "pi_no_compaction.cancel", { runId }); f.send("held");
    f.complete(assistant([write("w"), edit("e"), read("r")]));
    f.complete(fileResult(), active(f, "r")); f.complete(fileResult(), active(f, "w")); f.complete(fileResult(), active(f, "e"));
    assert.equal(f.state().phase, "cancelled"); assert.equal(f.state().pendingMessageCount, 1);
    f.send("resume", "pi_no_compaction.resume", {});
    f.send("late-cancel", "pi_no_compaction.cancel", { runId });
    assert.equal(f.state().cancelRequested, false); assert.equal(f.state().phase, "llm");
  } finally { f.storage.db.close(); }
});
test("steering queued during a text-only response continues the run", () => {
  const f = fixture(); try {
    f.send("go"); f.send("steer1"); f.send("steer2"); f.complete(assistant());
    assert.equal(f.state().phase, "llm"); assert.equal(f.request().input.messages.length, 4);
    f.complete(assistant()); assert.equal(f.state().phase, "idle");
  } finally { f.storage.db.close(); }
});
test("batch replay before commit reconstructs identical operation IDs and early callbacks deduplicate", () => {
  const f = fixture(); try {
    f.send("go");
    const llm = f.runtime.getPendingOperations()[0]!;
    f.runtime.acceptCompletion({ operationId: llm.operationId, provider: llm.provider, jobId: llm.jobId, submissionId: llm.operationId, outcome: assistant([nativeCall("one"), read("two"), write("w"), edit("e")]) });
    const plan = f.runtime.prepareNext()!;
    const requests = plan.operations;
    assert.equal(requests.length, 3);
    const op = requests[1]!;
    const value = { provider: op.request.provider, operationId: op.operationId, submissionId: op.submissionId, jobId: `job-${op.operationId}`, outcome: fileResult() };
    const early = f.runtime.acceptCompletion(value); assert.equal(early.duplicate, false);
    f.restart(); const replay = f.runtime.prepareNext()!; assert.deepEqual(replay.operations, requests);
    f.process(); f.process();
    assert.equal(f.runtime.acceptCompletion(value).duplicate, true);
    assert.equal(f.state().phase, "tools");
  } finally { f.storage.db.close(); }
});
test("malformed, duplicate, unknown and incomplete native calls fail without tool execution", () => {
  for (const response of [assistant([nativeCall("dup"), nativeCall("dup")]), assistant([nativeCall("bad", {}, "other")]),
    assistant([nativeCall("truncated")], "length"), assistant([nativeCall("call")], "stop"), assistant([{ type: "unknown" }])]) {
    const f = fixture(); try {
      f.send("go"); f.complete(response);
      assert.equal(f.state().phase, "failed"); assert.equal(f.runtime.getPendingOperations().length, 0);
      assert.equal(f.page().messages.at(-1)?.inContext, false);
    } finally { f.storage.db.close(); }
  }
  assert.throws(() => toolCalls({ role: "assistant", provider: "fireworks", content: [{ role: "assistant", tool_calls: {} }] }));
  assert.throws(() => toolCalls({ role: "assistant", provider: "fireworks", content: [{ role: "assistant", function_call: {} }] }));
});
test("malformed results stop safely after active siblings settle; partial edits remain tool errors", () => {
  const f = fixture(); try {
    f.send("go"); f.complete(assistant([read("bad"), nativeCall("b")]));
    f.complete({ status: "succeeded", result: { content: [{ type: "image", url: "bad" }], isError: false, details: {} } }, active(f, "bad"));
    assert.equal(f.state().phase, "tools"); f.complete(bash(), active(f, "b")); assert.equal(f.state().phase, "failed");
    f.send("resume", "pi_no_compaction.resume", {}); f.complete(assistant([edit("partial")]));
    f.complete({ status: "succeeded", result: { content: [{ type: "text", text: "File may have changed; inspect before editing." }], isError: true, details: { status: "partial", changesExact: false, changes: [] } } }, active(f, "partial"));
    assert.equal(f.state().phase, "llm");
  } finally { f.storage.db.close(); }
});
test("history never compacts; request limits become a committed failure", () => {
  const f = fixture(); try {
    for (let i = 0; i < 9; i++) appendMessage(f.storage.sql, { role: "user", content: [{ type: "text", text: "x".repeat(1_000_000) }] }, null);
    f.send("go"); assert.equal(f.state().phase, "failed"); assert.equal(f.runtime.getPendingOperations().length, 0);
    assert.equal((f.state().error as { code: string }).code, "OPERATION_INPUT_TOO_LARGE");
    assert.equal(f.page().state.pendingMessageCount, 0);
  } finally { f.storage.db.close(); }
});
test("excluded native responses remain readable and outside model context", () => {
  const f = fixture(); try {
    appendMessage(f.storage.sql, { role: "custom", tag: "excluded", data: "x".repeat(1_000_000) }, null, { inContext: false });
    const input = buildLlmInput(f.storage.sql, parsePiNoCompactionConfig(config), "s") as { messages: JsonValue[] };
    assert.deepEqual(input.messages, []); assert.equal(f.page().messages.length, 1);
  } finally { f.storage.db.close(); }
});
test("rollback after next-mutation acceptance replays the same operation and retains active siblings", () => {
  const f = fixture(); try {
    f.send("go"); f.complete(assistant([write("w"), edit("e"), read("r")]));
    const operationId = active(f, "w"), pending = f.runtime.getPendingOperations().find(op => op.operationId === operationId)!;
    f.runtime.acceptCompletion({ operationId, submissionId: operationId, provider: pending.provider, jobId: pending.jobId, outcome: fileResult() });
    f.storage.db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON pi_no_compaction_messages BEGIN SELECT RAISE(ABORT, 'injected rollback'); END");
    assert.throws(() => f.process(), /injected rollback/);
    const acceptedEdit = [...f.submitted.values()].find(op => op.request.provider === "tool-pi-edit")!; assert.ok(acceptedEdit);
    assert.equal(f.state().activeToolCount, 2);
    f.storage.db.exec("DROP TRIGGER fail_message"); f.restart(); f.process();
    assert.equal(active(f, "e"), acceptedEdit.operationId);
    assert.equal([...f.submitted.values()].filter(op => op.request.provider === "tool-pi-edit").length, 1);
    f.complete(fileResult(), active(f, "e")); f.complete(fileResult(), active(f, "r"));
    assert.equal(f.state().phase, "llm");
  } finally { f.storage.db.close(); }
});
test("oversized derived tool messages fail safely without orphaning sibling operations", () => {
  const f = fixture(); try {
    const id = "x".repeat(2048);
    f.send("go"); f.complete(assistant([read(id), nativeCall("b")]));
    f.complete(fileResult("x".repeat(1_899_600)), active(f, id));
    assert.equal(f.state().phase, "tools"); assert.equal(f.state().activeToolCount, 1);
    f.complete(bash(), active(f, "b"));
    assert.equal(f.state().phase, "failed"); assert.equal(f.runtime.getPendingOperations().length, 0);
    assert.equal((f.state().error as { code: string }).code, "INVALID_TOOL_RESULT");
  } finally { f.storage.db.close(); }
});
test("oversized direct steering is rejected before admission and cannot interrupt an active batch", () => {
  const f = fixture(); try {
    f.send("go"); f.complete(assistant([read("r")]));
    assert.throws(() => f.send("huge", "pi_no_compaction.message", { message: { role: "user", content: [{ type: "text", text: "x".repeat(1_800_000) }] } }));
    assert.equal(f.state().phase, "tools"); assert.equal(f.state().pendingMessageCount, 0);
    f.complete(fileResult(), active(f, "r")); assert.equal(f.state().phase, "llm");
  } finally { f.storage.db.close(); }
});
test("provider mismatches fail before any tool submission", () => {
  const f = fixture(); try {
    f.send("go"); f.complete(fireworks());
    assert.equal(f.state().phase, "failed"); assert.equal((f.state().error as { code: string }).code, "LLM_MODEL_MISMATCH");
    assert.equal(f.page().messages.at(-1)?.inContext, false);
  } finally { f.storage.db.close(); }
});
