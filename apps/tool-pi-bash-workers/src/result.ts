import { BASH_GATEWAY_PREVIEW_BYTES, PI_BASH_MAX_BYTES, PI_BASH_MAX_LINES, isAbsoluteMachinePath, parseJsonValue, parseUuid } from "@managed-agents/contracts";
import type { BashResult, JsonValue } from "@managed-agents/contracts";

type ObjectValue = { [key: string]: JsonValue };
export function object(value: unknown): ObjectValue {
  const json = parseJsonValue(value);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid execution gateway object.");
  return json;
}
function string(value: JsonValue | undefined, max = 8192): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid execution gateway string.");
  return value;
}
function number(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid execution gateway count.");
  return value;
}
function bool(value: JsonValue | undefined): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid execution gateway flag.");
  return value;
}
/** Rust serde SystemTime is an object, unlike gateway metadata's RFC3339 timestamps. */
function time(value: JsonValue | undefined): string {
  const t = object(value), nanos = number(t.nanos_since_epoch);
  if (nanos >= 1e9) throw new Error("Invalid execution timestamp.");
  return new Date(number(t.secs_since_epoch) * 1000 + Math.floor(nanos / 1e6)).toISOString();
}
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const lines = (text: string) => text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");

/** Pi's tail policy: preserve complete final lines unless the final line alone exceeds the byte cap. */
export function truncateTail(text: string) {
  const all = lines(text), totalBytes = bytes(text);
  if (all.length <= PI_BASH_MAX_LINES && totalBytes <= PI_BASH_MAX_BYTES) {
    return { text, outputLines: all.length, outputBytes: totalBytes, truncatedBy: null, lastLinePartial: false };
  }
  const kept: string[] = [];
  let size = 0, partial = false, by: "lines" | "bytes" = "lines";
  for (let i = all.length - 1; i >= 0 && kept.length < PI_BASH_MAX_LINES; i--) {
    const line = all[i]!, count = bytes(line) + (kept.length ? 1 : 0);
    if (size + count > PI_BASH_MAX_BYTES) {
      by = "bytes";
      if (!kept.length) {
        const raw = encoder.encode(line);
        let start = raw.length - PI_BASH_MAX_BYTES;
        while (start < raw.length && (raw[start]! & 0xc0) === 0x80) start++;
        kept.push(new TextDecoder().decode(raw.subarray(start))); partial = true;
      }
      break;
    }
    kept.push(line); size += count;
  }
  if (kept.length >= PI_BASH_MAX_LINES) by = "lines";
  const output = kept.reverse().join("\n");
  return { text: output, outputLines: kept.length, outputBytes: bytes(output), truncatedBy: by, lastLinePartial: partial };
}

export function formatRun(value: unknown, correlation: { jobId: string; machineId: string; runId: string; generationId: string }, timeout: number | null): BashResult {
  const run = object(value);
  if (run.run_id !== correlation.runId) throw new Error("Gateway returned a different run.");
  const execution = object(run.execution), handle = object(execution.handle);
  if (execution.state !== "finished" || handle.generation_id !== correlation.generationId) throw new Error("Gateway run is not a matching finished execution.");
  const executionHandle = { id: parseUuid(handle.id), generation_id: parseUuid(handle.generation_id) };
  const exit = object(execution.result), reason = string(exit.reason);
  if (!["exited", "timed_out", "terminated", "start_failed", "lost"].includes(reason)) throw new Error("Unknown execution result.");
  let exitCode: number | null = null, signal: string | null = null;
  if (["exited", "timed_out", "terminated"].includes(reason)) {
    exitCode = exit.exit_code === null ? null : number(exit.exit_code);
    signal = exit.signal === null ? null : string(exit.signal, 200);
  }
  const file = object(run.output_file), path = string(file.path);
  if (!isAbsoluteMachinePath(path)) throw new Error("Gateway output file path is not absolute.");
  const fileComplete = bool(file.complete), captureIncomplete = bool(execution.output_incomplete);
  const outputFile = { artifactId: parseUuid(file.artifact_id), sizeBytes: number(file.size_bytes),
    sha256: string(file.sha256, 64), complete: fileComplete && !captureIncomplete, expiresAt: time(file.expires_at) };
  if (!/^[a-f0-9]{64}$/.test(outputFile.sha256)) throw new Error("Invalid output file digest.");
  const upstreamTruncated = bool(run.output_truncated);
  if (!Array.isArray(run.output)) throw new Error("Invalid output chunks.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (const item of run.output) {
    const chunk = object(item);
    if (!["stdout", "stderr"].includes(string(chunk.stream))) throw new Error("execution.run must return pipe output.");
    const encoded = string(chunk.data_base64, Math.ceil(BASH_GATEWAY_PREVIEW_BYTES / 3) * 4);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Invalid output base64.");
    const decoded = atob(encoded);
    if (btoa(decoded) !== encoded) throw new Error("Noncanonical output base64.");
    length += decoded.length;
    if (length > BASH_GATEWAY_PREVIEW_BYTES) throw new Error("Gateway exceeded requested preview limit.");
    chunks.push(Uint8Array.from(decoded, char => char.charCodeAt(0)));
  }
  if (outputFile.complete && (outputFile.sizeBytes < length || (!upstreamTruncated && outputFile.sizeBytes !== length))) {
    throw new Error("Output file size conflicts with preview.");
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  const missingPrefix = upstreamTruncated && (outputFile.sizeBytes > length || !outputFile.complete);
  let start = 0;
  // A raw-byte gateway tail may begin inside a UTF-8 character. Decode across chunk boundaries.
  if (missingPrefix) while (start < Math.min(3, raw.length) && (raw[start]! & 0xc0) === 0x80) start++;
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: missingPrefix }).decode(raw.subarray(start));
  const tail = truncateTail(text);
  const truncated = upstreamTruncated || tail.truncatedBy !== null;
  const truncation: BashResult["details"]["truncation"] = {
    truncated, truncatedBy: tail.truncatedBy ?? (upstreamTruncated ? "upstream" : null),
    outputLines: tail.outputLines, outputBytes: tail.outputBytes, maxLines: PI_BASH_MAX_LINES, maxBytes: PI_BASH_MAX_BYTES,
    totalLines: missingPrefix || !outputFile.complete ? null : lines(text).length,
    totalTextBytes: missingPrefix || !outputFile.complete ? null : bytes(text), upstreamTruncated, lastLinePartial: tail.lastLinePartial,
  };
  const isError = reason !== "exited" || exitCode !== 0 || signal !== null || !outputFile.complete;
  let formatted = tail.text || (reason === "timed_out" || reason === "terminated" ? "" : "(no output)");
  const append = (note: string) => { formatted += `${formatted ? "\n\n" : ""}${note}`; };
  if (truncated) {
    if (truncation.totalLines !== null && !tail.lastLinePartial) {
      const first = truncation.totalLines - tail.outputLines + 1;
      append(`[Showing lines ${first}-${truncation.totalLines} of ${truncation.totalLines}${tail.truncatedBy === "bytes" ? " (50.0KB limit)" : ""}. ${outputFile.complete ? "Full" : "Partial"} output: ${path}]`);
    } else {
      append(`[Showing last ${tail.outputLines} lines (${(tail.outputBytes / 1024).toFixed(1)}KB) of available output. ${outputFile.complete ? "Full" : "Partial"} output: ${path}]`);
    }
  }
  if (!outputFile.complete) append(`[Output capture is incomplete. Partial output file: ${path}]`);
  switch (reason) {
    case "timed_out": append(timeout === null ? "Command timed out" : `Command timed out after ${timeout} seconds`); break;
    case "terminated": append("Command aborted"); break;
    case "start_failed": append(`Command failed to start: ${string(exit.message, 2000)}`); break;
    case "lost": append(`Command outcome is unknown; do not automatically retry: ${string(exit.message, 2000)}`); break;
    case "exited":
      if (signal !== null) append(`Command terminated by signal ${signal}`);
      else if (exitCode === null) append("Command terminated without an exit code");
      else if (exitCode !== 0) append(`Command exited with code ${exitCode}`);
  }
  return { content: [{ type: "text", text: formatted }], isError, details: {
    gatewayJobId: correlation.jobId, machineId: correlation.machineId, runId: correlation.runId, executionHandle,
    reason: reason as BashResult["details"]["reason"], exitCode, signal, timedOut: reason === "timed_out",
    fullOutputPath: path, outputFile, truncation,
  } };
}
