import { isAbsoluteMachinePath } from "@managed-agents/contracts";
import type { JsonValue, WriteResult } from "@managed-agents/contracts";
import type { WriteContext } from "./context.ts";
import { writeIdentity } from "./context.ts";

export function object(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, JsonValue>;
}
export function writeError(context: Pick<WriteContext, "machineId" | "path">, code: string, message: string, requestId?: string): WriteResult {
  return { content: [{ type: "text", text: message }], isError: true,
    details: { ...(requestId === undefined ? {} : { requestId: requestId }), machineId: context.machineId, path: context.path, error: { code, message } } };
}
export function fileTooLarge(context: Pick<WriteContext, "machineId" | "path">): WriteResult {
  return writeError(context, "WRITE_FILE_TOO_LARGE", "Content is too big to write. The maximum file size is 5 MiB (5,242,880 UTF-8 bytes). No write was submitted.");
}
export async function formatReceipt(value: unknown, context: WriteContext, requestId: string): Promise<WriteResult> {
  const r = object(value);
  if (r.mutation_id !== await writeIdentity(context.submissionId) || r.sha256 !== context.contentSha256
    || r.bytes_written !== context.contentBytes || (r.disposition !== "applied" && r.disposition !== "already_applied")
    || typeof r.path !== "string" || r.path.length > 16384 || !isAbsoluteMachinePath(r.path)) throw new Error("Filesystem write receipt conflicts with submission.");
  return { content: [{ type: "text", text: `Successfully wrote to ${context.path}` }], isError: false,
    details: { requestId: requestId, machineId: context.machineId, path: context.path,
      file: { path: r.path, mutationId: r.mutation_id, sha256: r.sha256, bytesWritten: r.bytes_written, disposition: r.disposition } } };
}
