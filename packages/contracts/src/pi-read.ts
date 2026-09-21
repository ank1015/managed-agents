import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import { parseProviderSubmission } from "./operation.ts";
import type { ProviderSubmission } from "./operation.ts";
import { parseUuid } from "./llm.ts";
import type { LlmContent, LlmTool, SessionDestination } from "./llm.ts";
import { isAbsoluteMachinePath } from "./pi-bash.ts";
import { nonemptyString, record } from "./validation.ts";

export const PI_READ_OPERATION = Object.freeze({ provider: "tool-pi-read", type: "read", version: "v1" });
export const PI_READ_RECEIVER = "tool-pi-read-v1";
export const PI_READ_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const PI_READ_MAX_LINES = 2000;
export const PI_READ_MAX_BYTES = 50 * 1024;

/** Pi's model-facing arguments; machine and cwd belong to the trusted caller. */
export const PI_READ_TOOL = Object.freeze({
  type: "function", name: "read",
  description: "Read the contents of a file (maximum 5 MiB). Supports text files and images (jpg, png, gif, webp, bmp). Images are returned as URL attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
  parameters: {
    type: "object", properties: {
      path: { type: "string", description: "Path to the file to read (relative or absolute)" },
      offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    }, required: ["path"], additionalProperties: false,
  },
} satisfies LlmTool);

export type ReadToolInput = { path: string; offset?: number; limit?: number };
export type ReadInput = ReadToolInput & { machineId: string; cwd: string };
export interface ReadSubmission { destination: SessionDestination; submission: ProviderSubmission }
export interface ReadWorkerBinding { submit(value: unknown): Promise<unknown> }

export function parseReadToolInput(value: unknown): ReadToolInput {
  const r = record(parseJsonValue(value), ["path", "offset", "limit"], "read arguments");
  const path = nonemptyString(r.path, "path");
  if (path.includes("\0") || path.length > 8192) throw new ContractException("INVALID_REQUEST", "path must contain no NUL bytes and be at most 8192 characters.");
  for (const key of ["offset", "limit"] as const) {
    if (r[key] !== undefined && (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || r[key] < 1)) {
      throw new ContractException("INVALID_REQUEST", `${key} must be a positive safe integer.`);
    }
  }
  return { path, ...(r.offset === undefined ? {} : { offset: r.offset as number }),
    ...(r.limit === undefined ? {} : { limit: r.limit as number }) };
}
export function parseReadInput(value: unknown): ReadInput {
  const r = record(parseJsonValue(value), ["machineId", "cwd", "path", "offset", "limit"], "read input");
  const cwd = nonemptyString(r.cwd, "cwd");
  if (!isAbsoluteMachinePath(cwd) || cwd.length > 8192) throw new ContractException("INVALID_REQUEST", "cwd must be an absolute machine path of at most 8192 characters.");
  return { machineId: parseUuid(r.machineId), cwd,
    ...parseReadToolInput({ path: r.path!, ...(r.offset === undefined ? {} : { offset: r.offset }), ...(r.limit === undefined ? {} : { limit: r.limit }) }) };
}
export function parseReadSubmission(value: unknown): ReadSubmission {
  const r = record(parseJsonValue(value), ["destination", "submission"], "read submission");
  const d = record(r.destination, ["routeKey", "sessionId"], "destination");
  const destination = { routeKey: nonemptyString(d.routeKey, "routeKey"), sessionId: nonemptyString(d.sessionId, "sessionId") };
  const submission = parseProviderSubmission(r.submission);
  for (const id of [destination.routeKey, destination.sessionId, submission.operationId, submission.submissionId]) {
    if (id.length > 2048) throw new ContractException("INVALID_REQUEST", "Operation routing identifier is too long.");
  }
  return { destination, submission };
}

export type ReadTruncation = {
  content: string; truncated: boolean; truncatedBy: "lines" | "bytes" | null;
  totalLines: number; totalBytes: number; outputLines: number; outputBytes: number;
  lastLinePartial: false; firstLineExceedsLimit: boolean; maxLines: number; maxBytes: number;
};
export type ReadResult = {
  content: LlmContent[];
  /** Expected file/argument/size errors are completed tool invocations. */
  isError: boolean;
  details: {
    gatewayJobId: string; machineId: string; path: string;
    file?: { sizeBytes: number; sha256: string; modifiedAt: number | null; isSymlink: boolean };
    truncation?: ReadTruncation;
    image?: { id: string; url: string; mimeType: string; originalMimeType: string };
    error?: { code: string; message: string };
  };
};
