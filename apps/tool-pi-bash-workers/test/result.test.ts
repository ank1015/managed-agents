import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRun, truncateTail } from "../src/result.ts";
import { runResult, machineId, generationId } from "./stack.ts";

const correlation = { jobId: "00000000-0000-4000-8000-000000000005", machineId, generationId, runId: "run" };
const format = (value: unknown, timeout: number | null = null) => formatRun(value, correlation, timeout);
test("Pi tail preserves small output exactly and applies independent byte/line caps", () => {
  for (const text of ["", "hello", "hello\n", "\n", "a\n\n"]) {
    assert.equal(truncateTail(text).text, text);
    assert.equal(truncateTail(text).truncatedBy, null);
  }
  const text = Array.from({ length: 2001 }, (_, i) => String(i)).join("\n") + "\n";
  const result = format(runResult("run", text));
  assert.equal(result.details.truncation.outputLines, 2000);
  assert.equal(result.details.truncation.truncatedBy, "lines");
  assert.ok(result.content[0]!.text.startsWith("1\n2\n"));
  assert.match(result.content[0]!.text, /Showing lines 2-2001 of 2001/);
  const bytes = truncateTail(("x".repeat(99) + "\n").repeat(600));
  assert.equal(bytes.truncatedBy, "bytes");
  assert.equal(bytes.lastLinePartial, false);
  assert.equal(bytes.outputLines, 512);
  assert.ok(bytes.outputBytes <= 51200);
});
test("upstream 64-KiB tail is bounded to 50 KiB, with honest counts and an expiring full file", () => {
  const result = format(runResult("run", "head-not-returned\n" + "😀".repeat(20000)));
  const t = result.details.truncation;
  assert.equal(t.upstreamTruncated, true);
  assert.equal(t.totalLines, null); assert.equal(t.totalTextBytes, null);
  assert.equal(t.outputBytes, 51200); assert.equal(t.lastLinePartial, true);
  assert.ok(!result.content[0]!.text.includes("head-not-returned"));
  assert.ok(!result.content[0]!.text.includes("�"));
  assert.match(result.content[0]!.text, /Full output: \/machine\/outputs\/run.log/);
  assert.equal(result.details.outputFile.expiresAt, "2033-05-18T03:33:20.123Z");
  assert.equal(result.details.outputFile.complete, true);
});
test("stdout/stderr are decoded in capture order across chunk and raw-tail UTF-8 boundaries", () => {
  const run = runResult("run", "A😀B\n"), raw = Buffer.from("A😀B\n");
  run.output = [{ stream: "stdout", data_base64: raw.subarray(0, 3).toString("base64") },
    { stream: "stderr", data_base64: raw.subarray(3).toString("base64") }];
  assert.equal(format(run).content[0]!.text, "A😀B\n");
  const cut = runResult("run", "😀".repeat(17000) + "x");
  const result = format(cut);
  assert.ok(!result.content[0]!.text.includes("�"));
  assert.ok(result.details.truncation.outputBytes <= 51200);
  const binary = runResult("run", "xxx");
  binary.output[0]!.data_base64 = Buffer.from([0xff, 0x00, 0x61]).toString("base64");
  assert.equal(format(binary).content[0]!.text, "�\0a");
});
test("known command failures retain their output and tool error status", () => {
  assert.equal(format(runResult("run", "")).content[0]!.text, "(no output)");
  assert.equal(format(runResult("run", "")).isError, false);
  for (const [reason, code, note] of [["exited", 7, "Command exited with code 7"],
    ["timed_out", null, "Command timed out after 1.25 seconds"], ["terminated", null, "Command aborted"],
    ["start_failed", null, "Command failed to start"], ["lost", null, "Command outcome is unknown"]] as const) {
    const result = format(runResult("run", "partial output", reason, code), 1.25);
    assert.equal(result.isError, true);
    assert.equal(result.details.reason, reason);
    assert.ok(result.content[0]!.text.startsWith("partial output\n\n"));
    assert.ok(result.content[0]!.text.includes(note));
  }
  assert.equal(format(runResult("run", "", "timed_out", null), 2).content[0]!.text, "Command timed out after 2 seconds");
  const signal = runResult("run", "", "exited", null);
  assert.equal(format({ ...signal, execution: { ...signal.execution, result: { reason: "exited", exit_code: null, signal: "SIGKILL" } } }).isError, true);
});
test("incomplete captures cannot masquerade as complete output, even on exit zero", () => {
  for (const reason of ["file", "execution"]) {
    const run = runResult("run", "partial");
    if (reason === "file") run.output_file.complete = false;
    else run.execution.output_incomplete = true;
    const result = format(run);
    assert.equal(result.isError, true);
    assert.equal(result.details.outputFile.complete, false);
    assert.equal(result.details.truncation.totalLines, null);
    assert.match(result.content[0]!.text, /Output capture is incomplete/);
  }
});
test("malformed, oversized and miscorrelated gateway results are not admitted", () => {
  const run = runResult("run");
  for (const value of [null, { ...run, run_id: "other" }, { ...run, output_truncated: "false" },
    { ...run, execution: { ...run.execution, state: "running" } },
    { ...run, execution: { ...run.execution, handle: { ...run.execution.handle, generation_id: machineId } } },
    { ...run, output_file: { ...run.output_file, path: "relative" } },
    { ...run, output_file: { ...run.output_file, size_bytes: 1 } },
    { ...run, output_file: { ...run.output_file, sha256: "bad" } },
    { ...run, output: [{ stream: "stdout", data_base64: "!" }] },
    { ...run, output: [{ stream: "stdout", data_base64: Buffer.alloc(65537).toString("base64") }] }]) assert.throws(() => format(value));
});
