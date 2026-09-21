import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReadToolInput, parseReadInput, parseReadSubmission, PI_READ_OPERATION, PI_READ_TOOL, PI_READ_MAX_FILE_BYTES } from "../src/index.ts";

const base = { machineId: "00000000-0000-4000-8000-000000000001", cwd: "/workspace", path: "src/file.ts" };
test("read exposes Pi's path/offset/limit schema and keeps machine/cwd outside model arguments", () => {
  assert.equal(PI_READ_TOOL.name, "read");
  assert.deepEqual(Object.keys(PI_READ_TOOL.parameters.properties).sort(), ["limit", "offset", "path"]);
  assert.deepEqual(PI_READ_TOOL.parameters.required, ["path"]);
  assert.equal(PI_READ_MAX_FILE_BYTES, 5_242_880);
  assert.deepEqual(parseReadToolInput({ path: "~literal/file", offset: 2, limit: 10 }), { path: "~literal/file", offset: 2, limit: 10 });
  assert.deepEqual(parseReadInput(base), base);
  assert.deepEqual(parseReadInput({ ...base, path: "C:\\file.txt", cwd: "C:\\workspace" }).path, "C:\\file.txt");
  for (const args of [{ path: "" }, { path: "a\0b" }, { path: "x".repeat(8193) }, { path: "x", machineId: base.machineId },
    { path: "x", cwd: "/tmp" }, { path: "x", clientContext: {} }, { path: "x", max_bytes: 1 }]) assert.throws(() => parseReadToolInput(args));
  for (const key of ["offset", "limit"]) for (const value of [0, -1, 1.5, NaN, Infinity, null, "1", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseReadToolInput({ path: "x", [key]: value }));
  }
  assert.throws(() => parseReadInput({ ...base, cwd: "relative" }));
  assert.throws(() => parseReadInput({ ...base, machineId: "no" }));
});
test("read submission accepts structured provider correlation and rejects caller routing injection", () => {
  const value = { destination: { routeKey: "test-v1", sessionId: "session" },
    submission: { operationId: "operation", submissionId: "operation", request: { ...PI_READ_OPERATION, input: base } } };
  assert.deepEqual(parseReadSubmission(value), value);
  assert.throws(() => parseReadSubmission({ ...value, destination: { ...value.destination, url: "https://example.com" } }));
  assert.throws(() => parseReadSubmission({ ...value, destination: { ...value.destination, sessionId: "x".repeat(2049) } }));
});
