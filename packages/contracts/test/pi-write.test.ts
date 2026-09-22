import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_WRITE_TOOL, PI_WRITE_OPERATION, PI_WRITE_MAX_FILE_BYTES, parseWriteToolInput, parseWriteInput, parseWriteSubmission } from "../src/index.ts";

const execution = { gatewayUrl: "https://gateway.test", token: `me1.00000000-0000-4000-8000-000000000001.1.${"x".repeat(43)}`, runtimeGeneration: "00000000-0000-4000-8000-000000000002" };
const input = { machineId: "00000000-0000-4000-8000-000000000001", cwd: "/workspace", path: "nested/file.txt", content: "" };
test("write exposes Pi's two required strings, including empty content, with trusted machine/cwd", () => {
  assert.equal(PI_WRITE_TOOL.name, "write");
  assert.deepEqual(Object.keys(PI_WRITE_TOOL.parameters.properties), ["path", "content"]);
  assert.deepEqual(PI_WRITE_TOOL.parameters.required, ["path", "content"]);
  assert.equal(PI_WRITE_MAX_FILE_BYTES, 5_242_880);
  assert.deepEqual(parseWriteInput(input), input);
  assert.deepEqual(parseWriteToolInput({ path: "~literal/@file", content: "\0नमस्ते\r\n" }), { path: "~literal/@file", content: "\0नमस्ते\r\n" });
  for (const value of [{ path: "x" }, { path: "x", content: null }, { path: "x", content: 3 }, { ...input },
    { path: "", content: "" }, { path: "a\0b", content: "" }, { path: "x".repeat(8193), content: "" },
    { path: "x", content: "", mode: "overwrite" }, { path: "x", content: "", mutation_id: "x" }]) {
    assert.throws(() => parseWriteToolInput(value));
  }
  assert.throws(() => parseWriteInput({ ...input, cwd: "relative" }));
  assert.throws(() => parseWriteInput({ ...input, cwd: "/x\0" }));
  assert.throws(() => parseWriteInput({ ...input, machineId: "bad" }));
  assert.equal(parseWriteInput({ ...input, cwd: "C:\\workspace", path: "C:\\file" }).path, "C:\\file");
});
test("write submission preserves immutable correlation and forbids callback injection", () => {
  const value = { execution, destination: { routeKey: "test-v1", sessionId: "session" },
    submission: { operationId: "op", submissionId: "sub", request: { ...PI_WRITE_OPERATION, input } } };
  assert.deepEqual(parseWriteSubmission(value), value);
  const {execution: omitted, ...legacy} = value;
  assert.throws(() => parseWriteSubmission(legacy));
  for (const patch of [{token:"has spaces"}, {userId:"bad user"}, {runtimeGeneration:"bad"}, {callbackUrl:"https://bad"}]) assert.throws(() => parseWriteSubmission({...value,execution:{...execution,...patch}}));
  assert.throws(() => parseWriteSubmission({ ...value, destination: { ...value.destination, url: "https://bad" } }));
  assert.throws(() => parseWriteSubmission({ ...value, destination: { ...value.destination, sessionId: "s".repeat(2049) } }));
  // The generic serialized transport budget is separate from the UTF-8 file cap.
  assert.throws(() => parseWriteSubmission({ ...value, submission: { ...value.submission,
    request: { ...PI_WRITE_OPERATION, input: { ...input, content: "\0".repeat(2 * 1024 * 1024) } } } }));
});
