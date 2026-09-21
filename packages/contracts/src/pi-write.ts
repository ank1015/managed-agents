import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import { parseProviderSubmission } from "./operation.ts";
import type { ProviderSubmission } from "./operation.ts";
import { parseUuid } from "./llm.ts";
import type { LlmTool, SessionDestination } from "./llm.ts";
import { isAbsoluteMachinePath } from "./pi-bash.ts";
import { nonemptyString, record } from "./validation.ts";

export const PI_WRITE_OPERATION = Object.freeze({ provider: "tool-pi-write", type: "write", version: "v1" });
export const PI_WRITE_RECEIVER = "tool-pi-write-v1";
export const PI_WRITE_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Pi's model arguments. Routing, machine and cwd are supplied by the trusted caller. */
export const PI_WRITE_TOOL = Object.freeze({
  type: "function", name: "write",
  description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Content must be at most 5 MiB in UTF-8. Use write only for new files or complete rewrites.",
  parameters: {
    type: "object", properties: {
      path: { type: "string", description: "Path to the file to write (relative or absolute)" },
      content: { type: "string", description: "Content to write to the file" },
    }, required: ["path", "content"], additionalProperties: false,
  },
} satisfies LlmTool);

export type WriteToolInput = { path: string; content: string };
export type WriteInput = WriteToolInput & { machineId: string; cwd: string };
export interface WriteSubmission { destination: SessionDestination; submission: ProviderSubmission }
export interface WriteWorkerBinding { submit(value: unknown): Promise<unknown> }

/** Size is checked by the worker so oversized content becomes a completed tool error. */
export function parseWriteToolInput(value: unknown): WriteToolInput {
  const r = record(parseJsonValue(value), ["path", "content"], "write arguments");
  const path = nonemptyString(r.path, "path");
  if (path.includes("\0") || path.length > 8192) throw new ContractException("INVALID_REQUEST", "path must contain no NUL bytes and be at most 8192 characters.");
  if (typeof r.content !== "string") throw new ContractException("INVALID_REQUEST", "content must be a string.");
  return { path, content: r.content };
}
export function parseWriteInput(value: unknown): WriteInput {
  const r = record(parseJsonValue(value), ["machineId", "cwd", "path", "content"], "write input");
  const cwd = nonemptyString(r.cwd, "cwd");
  if (!isAbsoluteMachinePath(cwd) || cwd.length > 8192) throw new ContractException("INVALID_REQUEST", "cwd must be an absolute machine path of at most 8192 characters.");
  return { machineId: parseUuid(r.machineId), cwd, ...parseWriteToolInput({ path: r.path!, content: r.content! }) };
}
export function parseWriteSubmission(value: unknown): WriteSubmission {
  const r = record(parseJsonValue(value), ["destination", "submission"], "write submission");
  const d = record(r.destination, ["routeKey", "sessionId"], "destination");
  const destination = { routeKey: nonemptyString(d.routeKey, "routeKey"), sessionId: nonemptyString(d.sessionId, "sessionId") };
  const submission = parseProviderSubmission(r.submission);
  for (const id of [destination.routeKey, destination.sessionId, submission.operationId, submission.submissionId]) {
    if (id.length > 2048) throw new ContractException("INVALID_REQUEST", "Operation routing identifier is too long.");
  }
  return { destination, submission };
}

export type WriteResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
  details: {
    /** Absent for a local size error, before a gateway job exists. */
    gatewayJobId?: string;
    machineId: string; path: string;
    file?: { path: string; mutationId: string; sha256: string; bytesWritten: number; disposition: "applied" | "already_applied" };
    error?: { code: string; message: string };
  };
};
