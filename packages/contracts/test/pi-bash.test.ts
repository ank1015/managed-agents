import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_BASH_TOOL, PI_BASH_OPERATION, PI_BASH_MAX_TIMEOUT_MS, bashTimeoutMs, parseBashInput, parseBashToolInput, parseBashSubmission, parseLlmInput } from "../src/index.ts";

const machineId = "00000000-0000-4000-8000-000000000001";
const input = { machineId, cwd: "/workspace", command: "pwd" };
test("model sees only Pi command/timeout; harness supplies the execution destination", () => {
  assert.deepEqual(Object.keys(PI_BASH_TOOL.parameters.properties), ["command", "timeout"]);
  assert.deepEqual(PI_BASH_TOOL.parameters.required, ["command"]);
  assert.deepEqual(parseBashToolInput({ command: "" }), { command: "" });
  assert.deepEqual(parseBashInput(input), input);
  assert.deepEqual(parseBashSubmission({ execution: {token: `me1.00000000-0000-4000-8000-000000000001.1.${"x".repeat(43)}`, runtimeGeneration: "00000000-0000-4000-8000-000000000002"}, destination: { routeKey: "coding", sessionId: "s" },
    submission: { operationId: "o", submissionId: "sub", request: { ...PI_BASH_OPERATION, input } } }).submission.request.input, input);
  const llm = parseLlmInput({ accountId: machineId, modelId: "m", tools: [PI_BASH_TOOL],
    messages: [{ role: "user", content: [{ type: "text", text: "run pwd" }] }] });
  assert.ok("tools" in llm);
  assert.equal(llm.tools?.[0]?.name, "bash");
  assert.throws(() => parseBashToolInput(input));
  for (const extra of [{ apiKey: "secret" }, { callbackUrl: "https://no" }, { idempotencyKey: "k" }, { shell: "sh" }, { env: {} }]) {
    assert.throws(() => parseBashInput({ ...input, ...extra }));
  }
});
test("absolute machine paths, commands and UUIDs are validated without local filesystem access", () => {
  for (const cwd of ["/", "/not/on/this/machine", "C:\\workspace", "D:/workspace", "\\\\host\\share\\project"]) assert.equal(parseBashInput({ ...input, cwd }).cwd, cwd);
  for (const cwd of ["", ".", "relative/path", "~/project", "C:project", "\\project", "/bad\0path", "/".repeat(8193)]) assert.throws(() => parseBashInput({ ...input, cwd }));
  assert.throws(() => parseBashInput({ ...input, machineId: "not-a-uuid" }));
  for (const command of [undefined, null, 123, "echo\0bad"]) assert.throws(() => parseBashInput({ ...input, command }));
});
test("timeout is optional seconds with Pi's timer range and millisecond rounding", () => {
  assert.equal(Object.hasOwn(parseBashInput(input), "timeout"), false);
  for (const timeout of [0, -1, Infinity, NaN, "1", null, PI_BASH_MAX_TIMEOUT_MS / 1000 + 1]) assert.throws(() => parseBashInput({ ...input, timeout }));
  for (const timeout of [0.0001, 1.25, PI_BASH_MAX_TIMEOUT_MS / 1000]) assert.equal(parseBashInput({ ...input, timeout }).timeout, timeout);
  assert.equal(bashTimeoutMs(0.0001), 1);
  assert.equal(bashTimeoutMs(1.2349), 1234);
  assert.equal(bashTimeoutMs(PI_BASH_MAX_TIMEOUT_MS / 1000), PI_BASH_MAX_TIMEOUT_MS);
});

test("bash requires the server execution envelope", () => {
  assert.throws(() => parseBashSubmission({destination: {routeKey: "coding", sessionId: "s"},
    submission: {operationId: "o", submissionId: "o", request: {...PI_BASH_OPERATION, input}}}));
});
