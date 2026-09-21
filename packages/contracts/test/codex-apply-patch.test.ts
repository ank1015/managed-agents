import assert from "node:assert/strict";
import { test } from "node:test";
import { CODEX_APPLY_PATCH_TOOL, CODEX_APPLY_PATCH_OPERATION, parseApplyPatchToolInput, parseApplyPatchInput, parseApplyPatchSubmission, parseLlmInput } from "../src/index.ts";

const input = { machineId: "00000000-0000-4000-8000-000000000001", cwd: "/workspace", patch: "*** Begin Patch\n*** Add File: nested/hello.txt\n+नमस्ते 🌍\n*** End Patch\n" };
test("raw custom input preserves text, leaves syntax errors to the daemon and separates trusted routing", () => {
  assert.equal(parseApplyPatchToolInput(input.patch), input.patch);
  assert.equal(parseApplyPatchToolInput(" \r\nnot a patch\0"), " \r\nnot a patch\0");
  assert.equal(parseApplyPatchToolInput(""), "");
  assert.deepEqual(parseApplyPatchInput(input), input);
  for (const value of [{ patch: input.patch }, null, 42, [input.patch]]) assert.throws(() => parseApplyPatchToolInput(value));
  for (const value of [{ ...input, cwd: "relative" }, { ...input, cwd: "/x\0" }, { ...input, machineId: "bad" },
    { ...input, callbackUrl: "https://bad" }, { ...input, patch: {} }]) assert.throws(() => parseApplyPatchInput(value));
  assert.equal(parseApplyPatchInput({ ...input, cwd: "C:\\workspace" }).cwd, "C:\\workspace");
  const request = parseLlmInput({ accountId: input.machineId, modelId: "model", messages: [], tools: [CODEX_APPLY_PATCH_TOOL] });
  assert.ok("tools" in request); assert.deepEqual(request.tools, [CODEX_APPLY_PATCH_TOOL]);
});
test("submission rejects injected callback routing and excessive transport size", () => {
  const value = { execution: { token: `me1.${input.machineId}.1.${"x".repeat(43)}`, runtimeGeneration: "00000000-0000-4000-8000-000000000002" }, destination: { routeKey: "test-v1", sessionId: "session" },
    submission: { operationId: "op", submissionId: "sub", request: { ...CODEX_APPLY_PATCH_OPERATION, input } } };
  assert.deepEqual(parseApplyPatchSubmission(value), value);
  assert.throws(() => parseApplyPatchSubmission({ ...value, destination: { ...value.destination, url: "https://bad" } }));
  assert.throws(() => parseApplyPatchSubmission({ ...value, destination: { ...value.destination, sessionId: "s".repeat(2049) } }));
  assert.throws(() => parseApplyPatchSubmission({ ...value, submission: { ...value.submission,
    request: { ...CODEX_APPLY_PATCH_OPERATION, input: { ...input, patch: "\0".repeat(2 * 1024 * 1024) } } } }));
});
