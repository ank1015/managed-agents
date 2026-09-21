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

export function formatRun(value: unknown, correlation: { requestId: string; machineId: string; runtimeGeneration: string }, timeout: number | null): BashResult {
  const run = object(value);
  if (run.state !== "finished" || run.session_id !== null) throw new Error("Bash requires a finished native execution.");
  const nativeReason = string(run.reason, 4096);
  const reason = nativeReason.startsWith("start_failed: ") ? "start_failed" : nativeReason.startsWith("lost: ") ? "lost" : nativeReason;
  if (!["exited", "timed_out", "terminated", "start_failed", "lost"].includes(reason)) throw new Error("Unknown execution result.");
  const exitCode = run.exit_code === null ? null : number(run.exit_code);
  const signal = run.signal === null ? null : string(run.signal, 200);
  const originalBytes = number(run.original_bytes), captureIncomplete = bool(run.output_incomplete);
  if (typeof run.wall_time_seconds !== "number" || !Number.isFinite(run.wall_time_seconds) || run.wall_time_seconds < 0) throw new Error("Invalid execution duration.");
  const file = object(run.artifact), path = string(file.path);
  if (!isAbsoluteMachinePath(path)) throw new Error("Native output file path is not absolute.");
  const expiresAtMs = file.expires_at_ms === null ? null : number(file.expires_at_ms);
  if (expiresAtMs !== null && !Number.isFinite(new Date(expiresAtMs).getTime())) throw new Error("Invalid artifact expiration.");
  const outputFile = { artifactId: parseUuid(file.id), sizeBytes: number(file.size_bytes),
    complete: bool(file.complete) && !captureIncomplete, expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString() };
  if (outputFile.complete && outputFile.sizeBytes !== originalBytes) throw new Error("Output artifact size conflicts with native byte count.");
  const upstreamTruncated = bool(run.output_truncated);
  // The core now decodes merged stdout/stderr. Byte counts describe its raw capture,
  // which can differ from UTF-8 text size when invalid bytes are replaced.
  const text = string(run.output, BASH_GATEWAY_PREVIEW_BYTES);
  if (bytes(text) > BASH_GATEWAY_PREVIEW_BYTES) throw new Error("Native output exceeded the requested preview budget.");
  const missingPrefix = upstreamTruncated;
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
    case "start_failed": append(`Command failed to start: ${nativeReason.slice(nativeReason.indexOf(": ") + 2, 2000)}`); break;
    case "lost": append(`Command outcome is unknown; do not automatically retry: ${nativeReason.slice(nativeReason.indexOf(": ") + 2, 2000)}`); break;
    case "exited":
      if (signal !== null) append(`Command terminated by signal ${signal}`);
      else if (exitCode === null) append("Command terminated without an exit code");
      else if (exitCode !== 0) append(`Command exited with code ${exitCode}`);
  }
  return { content: [{ type: "text", text: formatted }], isError, details: {
    requestId: correlation.requestId, machineId: correlation.machineId, runtimeGeneration: correlation.runtimeGeneration,
    wallTimeSeconds: run.wall_time_seconds, originalBytes,
    reason: reason as BashResult["details"]["reason"], exitCode, signal, timedOut: reason === "timed_out",
    fullOutputPath: path, outputFile, truncation,
  } };
}
