import assert from "node:assert/strict";
import test from "node:test";
import { formatRun, truncateTail } from "../src/result.ts";
import { runResult, machineId, generationId } from "./stack.ts";
const correlation = { requestId: "pi-bash-v1:test", machineId, runtimeGeneration: generationId };
const format = (value: unknown, timeout: number | null = null) => formatRun(value, correlation, timeout);

test("Pi tail preserves small text and applies independent line/UTF-8 byte caps", () => {
  for (const text of ["", "hello", "hello\n", "\n", "a\n\n", "नमस्ते 🌍\r\n"]) assert.equal(truncateTail(text).text, text);
  const r = format(runResult(Array.from({length: 2001}, (_, i) => String(i)).join("\n") + "\n"));
  assert.equal(r.details.truncation.outputLines, 2000); assert.match(r.content[0]!.text, /Showing lines 2-2001 of 2001/);
  const tail = truncateTail(("x".repeat(99) + "\n").repeat(600));
  assert.equal(tail.truncatedBy, "bytes"); assert.equal(tail.outputLines, 512); assert.equal(tail.lastLinePartial, false);
  const huge = format(runResult("😀".repeat(20000)));
  assert.equal(huge.details.truncation.outputBytes, 51200); assert.equal(huge.details.truncation.lastLinePartial, true);
  assert.equal(huge.details.truncation.totalLines, null); assert.ok(!huge.content[0]!.text.includes("�"));
  assert.match(huge.content[0]!.text, /Full output: \/machine\/outputs\/run.log/);
});
test("native text, artifact expiry and known command failures are preserved", () => {
  assert.equal(format(runResult("")).content[0]!.text, "(no output)");
  const ordinary = format(runResult("stdout\nstderr\n"));
  assert.equal(ordinary.content[0]!.text, "stdout\nstderr\n");
  assert.equal(ordinary.details.outputFile.expiresAt, "2033-05-18T03:33:20.123Z");
  assert.equal(format({...runResult(), artifact: {...runResult().artifact, expires_at_ms: null}}).details.outputFile.expiresAt, null);
  for (const [reason, code, note] of [["exited", 7, "Command exited with code 7"], ["timed_out", null, "Command timed out after 1.25 seconds"],
    ["terminated", null, "Command aborted"], ["start_failed", null, "Command failed to start"], ["lost", null, "Command outcome is unknown"]] as const) {
    const r = format(runResult("partial", reason, code), 1.25); assert.equal(r.isError, true); assert.match(r.content[0]!.text, new RegExp(note));
  }
  assert.equal(format({...runResult("", "exited", null), signal: "SIGKILL"}).isError, true);
  assert.equal(format(runResult("", "timed_out", null), 2).content[0]!.text, "Command timed out after 2 seconds");
});
test("incomplete captures and lossy UTF-8 byte counts are represented honestly", () => {
  for (const patch of [{output_incomplete: true}, {artifact: {...runResult().artifact, complete: false}}]) {
    const r = format({...runResult(), ...patch}); assert.equal(r.isError, true); assert.equal(r.details.outputFile.complete, false);
    assert.equal(r.details.truncation.totalLines, null); assert.match(r.content[0]!.text, /Output capture is incomplete/);
  }
  const invalidBytes = {...runResult(), output: "�\0a", original_bytes: 3, artifact: {...runResult().artifact, size_bytes: 3}};
  assert.equal(format(invalidBytes).content[0]!.text, "�\0a");
});
test("malformed or nonterminal native execution receipts are rejected", () => {
  const run = runResult();
  for (const patch of [null, {...run, state: "running"}, {...run, session_id: 3}, {...run, output_truncated: "false"},
    {...run, original_bytes: -1}, {...run, wall_time_seconds: Infinity}, {...run, output: "x".repeat(65537)},
    {...run, artifact: {...run.artifact, path: "relative"}}, {...run, artifact: {...run.artifact, size_bytes: 1}},
    {...run, artifact: {...run.artifact, expires_at_ms: 9000000000000000}}, {...run, reason: "unknown"}]) assert.throws(() => format(patch));
});
