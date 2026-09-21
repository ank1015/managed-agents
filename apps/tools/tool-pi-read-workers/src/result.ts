import { Buffer } from "node:buffer";
import { PI_READ_MAX_BYTES, PI_READ_MAX_LINES, PI_READ_MAX_FILE_BYTES, isAbsoluteMachinePath } from "@managed-agents/contracts";
import type { JsonValue, ReadResult, ReadTruncation } from "@managed-agents/contracts";
import type { ReadContext } from "./context.ts";

export function object(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, JsonValue>;
}
export function readError(requestId: string, context: ReadContext, code: string, message: string): ReadResult {
  return { content: [{ type: "text", text: message }], isError: true,
    details: { requestId: requestId, machineId: context.machineId, path: context.path, error: { code, message } } };
}
export function fileTooLarge(requestId: string, context: ReadContext): ReadResult {
  return readError(requestId, context, "READ_FILE_TOO_LARGE", "File is too big to read. The maximum file size is 5 MiB (5,242,880 bytes), including when offset or limit is supplied.");
}
export type ReadFile = { bytes: Uint8Array; path: string; sha256: string; modifiedAt: number | null; isSymlink: boolean };
export async function decodeFile(value: unknown): Promise<ReadFile | "too_large"> {
  const r = object(value), metadata = object(r.file);
  if (r.type !== "bytes" || typeof metadata.path !== "string" || metadata.path.length > 16384 || !isAbsoluteMachinePath(metadata.path)
    || typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256) || typeof r.data_base64 !== "string"
    || typeof metadata.is_symlink !== "boolean" || typeof metadata.size_bytes !== "number" || !Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes < 0
    || (metadata.modified_at !== null && (typeof metadata.modified_at !== "number" || !Number.isSafeInteger(metadata.modified_at)))) {
    throw new Error("Malformed filesystem read result.");
  }
  if (r.data_base64.length > Math.ceil(PI_READ_MAX_FILE_BYTES / 3) * 4 || metadata.size_bytes > PI_READ_MAX_FILE_BYTES) return "too_large";
  const bytes = Buffer.from(r.data_base64, "base64");
  if (bytes.toString("base64") !== r.data_base64) throw new Error("Invalid padded base64 file bytes.");
  if (bytes.length > PI_READ_MAX_FILE_BYTES) return "too_large";
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
  if (digest !== metadata.sha256 || bytes.length !== metadata.size_bytes) throw new Error("File digest or size does not match returned bytes.");
  return { bytes, path: metadata.path, sha256: digest, modifiedAt: metadata.modified_at, isSymlink: metadata.is_symlink };
}

export function fileDetails(file: ReadFile, requestId: string, context: ReadContext): ReadResult["details"] {
  return { requestId: requestId, machineId: context.machineId, path: file.path,
    file: { sizeBytes: file.bytes.length, sha256: file.sha256, modifiedAt: file.modifiedAt, isSymlink: file.isSymlink } };
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
/** Pi's head truncation counts complete lines, excluding a final newline from line count. */
export function truncateHead(content: string): ReadTruncation {
  const totalBytes = Buffer.byteLength(content), lines = content.length ? content.split("\n") : [];
  if (content.endsWith("\n")) lines.pop();
  const base = { totalLines: lines.length, totalBytes, lastLinePartial: false as const, maxLines: PI_READ_MAX_LINES, maxBytes: PI_READ_MAX_BYTES };
  if (lines.length <= PI_READ_MAX_LINES && totalBytes <= PI_READ_MAX_BYTES) {
    return { ...base, content, truncated: false, truncatedBy: null, outputLines: lines.length, outputBytes: totalBytes, firstLineExceedsLimit: false };
  }
  if (Buffer.byteLength(lines[0]!) > PI_READ_MAX_BYTES) {
    return { ...base, content: "", truncated: true, truncatedBy: "bytes", outputLines: 0, outputBytes: 0, firstLineExceedsLimit: true };
  }
  const output: string[] = [];
  let outputBytes = 0, truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length && i < PI_READ_MAX_LINES; i++) {
    const bytes = Buffer.byteLength(lines[i]!) + (i > 0 ? 1 : 0);
    if (outputBytes + bytes > PI_READ_MAX_BYTES) { truncatedBy = "bytes"; break; }
    output.push(lines[i]!); outputBytes += bytes;
  }
  return { ...base, content: output.join("\n"), truncated: true, truncatedBy, outputLines: output.length, outputBytes, firstLineExceedsLimit: false };
}
export function formatText(file: ReadFile, requestId: string, context: ReadContext): ReadResult {
  // Replacement decoding and split preserve Pi's empty-file, CRLF, BOM and final-newline behavior.
  const allLines = Buffer.from(file.bytes).toString("utf8").split("\n"), start = (context.offset ?? 1) - 1;
  if (start >= allLines.length) return readError(requestId, context, "READ_OFFSET_OUT_OF_BOUNDS", `Offset ${context.offset} is beyond end of file (${allLines.length} lines total)`);
  const count = Math.min(context.limit ?? allLines.length, allLines.length - start);
  const truncation = truncateHead(allLines.slice(start, start + count).join("\n"));
  let text = truncation.content;
  const details = fileDetails(file, requestId, context);
  if (truncation.firstLineExceedsLimit) {
    text = `[Line ${start + 1} is ${formatSize(Buffer.byteLength(allLines[start]!))}, exceeds ${formatSize(PI_READ_MAX_BYTES)} limit. Use bash to read a bounded portion of this line.]`;
    details.truncation = truncation;
  } else if (truncation.truncated) {
    const end = start + truncation.outputLines;
    text += `\n\n[Showing lines ${start + 1}-${end} of ${allLines.length}${truncation.truncatedBy === "bytes" ? ` (${formatSize(PI_READ_MAX_BYTES)} limit)` : ""}. Use offset=${end + 1} to continue.]`;
    details.truncation = truncation;
  } else if (context.limit !== null && start + count < allLines.length) {
    text += `\n\n[${allLines.length - start - count} more lines in file. Use offset=${start + count + 1} to continue.]`;
  }
  return { content: [{ type: "text", text }], isError: false, details };
}
