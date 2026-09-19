import assert from "node:assert/strict";
import { test } from "node:test";
import { LLM_OPERATION, parseLlmInput, parseLlmResponse, parseOperationRequest, parseOperationOutcome, MAX_OPERATION_INPUT_BYTES } from "../src/index.ts";
const uuid = "00000000-0000-4000-8000-000000000001";
const base = { accountId: uuid, modelId: "model", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
test("LLM fresh and continuation inputs normalize only gateway defaults", () => {
  assert.deepEqual(parseLlmInput(base), { ...base, previousJobId: null, tools: [], providerOptions: {} });
  const continuation = { previousJobId: uuid, messages: [{ role: "custom", tag: "state", data: { opaque: true } }] };
  assert.deepEqual(parseLlmInput(continuation), continuation);
  for (const extra of [{ apiKey: "no" }, { idempotencyKey: "no" }, { webhookUrl: "https://no" }]) assert.throws(() => parseLlmInput({ ...base, ...extra }));
  assert.throws(() => parseLlmInput({ ...continuation, accountId: uuid }));
  assert.throws(() => parseLlmInput({ ...base, messages: [{ role: "assistant", content: [] }] }));
});
test("native assistant responses and custom tools stay intact", () => {
  const message = { role: "assistant", provider: "openai", content: [{ type: "reasoning", encrypted_content: "opaque" }] };
  const value = { ...base, messages: [message], tools: [{ type: "custom", name: "patch", description: "Patch", format: { syntax: "lark", definition: "start: WORD" } }] };
  assert.deepEqual(parseLlmInput(value).messages, value.messages);
  const response = { id: "r", modelId: "m", message, stopReason: "tool_use", durationMs: 10, timestamp: 1, usage: { input: 4, cost: { total: 0.001 } } };
  assert.deepEqual(parseLlmResponse(response), response);
});
test("8 MiB operation wire limits count UTF-8 bytes including JSON overhead", () => {
  assert.equal(MAX_OPERATION_INPUT_BYTES, 8 * 1024 * 1024);
  const exactInput = "x".repeat(MAX_OPERATION_INPUT_BYTES - 2);
  assert.equal(parseOperationRequest({ ...LLM_OPERATION, input: exactInput }).input, exactInput);
  const outcome = { status: "succeeded", result: "" };
  outcome.result = "x".repeat(MAX_OPERATION_INPUT_BYTES - JSON.stringify(outcome).length);
  assert.deepEqual(parseOperationOutcome(outcome), outcome);
  assert.throws(() => parseOperationRequest({ ...LLM_OPERATION, input: "x".repeat(MAX_OPERATION_INPUT_BYTES) }), /exceeds/);
  assert.throws(() => parseOperationRequest({ ...LLM_OPERATION, input: "😀".repeat(MAX_OPERATION_INPUT_BYTES / 3) }), /exceeds/);
  assert.throws(() => parseOperationOutcome({ status: "succeeded", result: "x".repeat(MAX_OPERATION_INPUT_BYTES) }), /exceeds/);
});
