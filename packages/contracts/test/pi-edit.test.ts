import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_EDIT_TOOL, PI_EDIT_OPERATION, parseEditToolInput, parseEditInput, parseEditSubmission } from "../src/index.ts";

const input = { machineId: "00000000-0000-4000-8000-000000000001", cwd: "/workspace", path: "nested/file.txt", edits: [{ oldText: " ", newText: "" }] };
test("edit exposes Pi's current schema with original-content replacements and trusted routing", () => {
  assert.equal(PI_EDIT_TOOL.name, "edit");
  assert.deepEqual(Object.keys(PI_EDIT_TOOL.parameters.properties), ["path", "edits"]);
  assert.deepEqual(PI_EDIT_TOOL.parameters.required, ["path", "edits"]);
  assert.deepEqual(parseEditInput(input), input);
  assert.deepEqual(parseEditToolInput({ path: "~literal/@file", edits: [{ oldText: "\0नमस्ते\r\n", newText: "" }] }),
    { path: "~literal/@file", edits: [{ oldText: "\0नमस्ते\r\n", newText: "" }] });
  for (const value of [{ path: "x" }, { path: "x", edits: [] }, { path: "x", edits: "[]" },
    { path: "x", oldText: "old", newText: "new" }, { ...input }, { path: "", edits: input.edits },
    { path: "a\0b", edits: input.edits }, { path: "x", edits: [{ oldText: "", newText: "x" }] },
    { path: "x", edits: [{ oldText: "old", newText: null }] }, { path: "x", edits: [{ oldText: "old", newText: "", mode: "all" }] },
    { path: "x", edits: Array(257).fill(input.edits[0]) }]) assert.throws(() => parseEditToolInput(value));
  assert.throws(() => parseEditInput({ ...input, cwd: "relative" }));
  assert.throws(() => parseEditInput({ ...input, cwd: "/x\0" }));
  assert.throws(() => parseEditInput({ ...input, machineId: "bad" }));
  assert.equal(parseEditInput({ ...input, cwd: "C:\\workspace" }).cwd, "C:\\workspace");
});
test("edit submission rejects injected callback routing and excessive transport size", () => {
  const value = { execution: { token: `me1.00000000-0000-4000-8000-000000000001.1.${"x".repeat(43)}`, runtimeGeneration: "00000000-0000-4000-8000-000000000002" }, destination: { routeKey: "test-v1", sessionId: "session" },
    submission: { operationId: "op", submissionId: "sub", request: { ...PI_EDIT_OPERATION, input } } };
  assert.deepEqual(parseEditSubmission(value), value);
  const { execution, ...legacy } = value;
  assert.throws(() => parseEditSubmission(legacy));
  assert.throws(() => parseEditSubmission({ ...value, execution: { ...execution, token: "bad token" } }));
  assert.throws(() => parseEditSubmission({ ...value, destination: { ...value.destination, url: "https://bad" } }));
  assert.throws(() => parseEditSubmission({ ...value, destination: { ...value.destination, sessionId: "s".repeat(2049) } }));
  assert.throws(() => parseEditSubmission({ ...value, submission: { ...value.submission,
    request: { ...PI_EDIT_OPERATION, input: { ...input, edits: [{ oldText: "x", newText: "\0".repeat(2 * 1024 * 1024) }] } } } }));
});
