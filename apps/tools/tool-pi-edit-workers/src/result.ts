import { isAbsoluteMachinePath, PI_EDIT_MAX_FILE_BYTES } from "@managed-agents/contracts";
import type { JsonValue, EditFileChange, EditResult } from "@managed-agents/contracts";
import type { EditContext } from "./context.ts";
import { editIdentity } from "./context.ts";

export function object(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, JsonValue>;
}
export function editError(context: Pick<EditContext, "machineId" | "path">, code: string, message: string, requestId?: string): EditResult {
  return { content: [{ type: "text", text: message }], isError: true,
    details: { ...(requestId === undefined ? {} : { requestId: requestId }), machineId: context.machineId, path: context.path, error: { code, message } } };
}
export function requestTooLarge(context: Pick<EditContext, "machineId" | "path">): EditResult {
  return editError(context, "EDIT_REQUEST_TOO_LARGE", "Edit request is too big. Serialized patch parameters must be at most 4 MiB. No edit was submitted.");
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function change(value: unknown): EditFileChange {
  const r = object(value);
  if (r.kind !== "update" || (r.destination_path !== undefined && r.destination_path !== null)
    || (r.destination_before_sha256 !== undefined && r.destination_before_sha256 !== null)
    || (r.destination_bytes_before !== undefined && r.destination_bytes_before !== null)
    || typeof r.path !== "string" || r.path.length > 16384 || !isAbsoluteMachinePath(r.path)
    || typeof r.before_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.before_sha256)
    || typeof r.after_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.after_sha256)
    || !integer(r.bytes_before, 0, PI_EDIT_MAX_FILE_BYTES) || !integer(r.bytes_after, 0, PI_EDIT_MAX_FILE_BYTES)
    || (r.first_changed_line !== null && !integer(r.first_changed_line, 1, PI_EDIT_MAX_FILE_BYTES + 1))) {
    throw new Error("Invalid filesystem edit change.");
  }
  return { path: r.path, beforeSha256: r.before_sha256, afterSha256: r.after_sha256,
    bytesBefore: r.bytes_before, bytesAfter: r.bytes_after,
    ...(r.first_changed_line === null ? {} : { firstChangedLine: r.first_changed_line as number }) };
}
/** The native runtime owns matching; signed job context and mutation ID bind its receipt to this input. */
export async function formatReceipt(value: unknown, context: EditContext, requestId: string): Promise<EditResult> {
  const r = object(value);
  if (r.mutation_id !== await editIdentity(context.submissionId)
    || !["applied", "rejected", "partial"].includes(r.status as string)
    || typeof r.changes_exact !== "boolean" || !Array.isArray(r.changes) || r.changes.length > 1
    || typeof r.diff !== "string" || new TextEncoder().encode(r.diff).byteLength > 64 * 1024
    || typeof r.diff_truncated !== "boolean") throw new Error("Filesystem patch receipt conflicts with submission.");
  const changes = r.changes.map(change);
  const status = r.status as "applied" | "rejected" | "partial";
  if ((status === "applied" && (!r.changes_exact || changes.length !== 1 || r.error !== null))
    || (status === "rejected" && (!r.changes_exact || changes.length !== 0))
    || (status === "partial" && r.changes_exact && changes.length === 0)) throw new Error("Inconsistent filesystem patch status.");
  let error: NonNullable<EditResult["details"]["error"]> | undefined;
  if (status !== "applied") {
    const e = object(r.error);
    if (typeof e.code !== "string" || !/^[a-z_]{1,100}$/.test(e.code)
      || typeof e.message !== "string" || !e.message
      || (e.section !== null && e.section !== 0)
      || (e.edit !== null && !integer(e.edit, 0, context.editCount - 1))) throw new Error("Invalid filesystem patch error.");
    const message = status === "partial"
      ? `The edit did not finish and the file may have changed. Inspect the file before attempting another edit. ${e.message.slice(0, 2000)}`
      : e.message.slice(0, 2000);
    error = { code: e.code, message,
      ...(e.section === null ? {} : { section: e.section as number }),
      ...(e.edit === null ? {} : { edit: e.edit as number }) };
  }
  const firstChangedLine = changes[0]?.firstChangedLine;
  return { content: [{ type: "text", text: error?.message ?? `Successfully replaced ${context.editCount} block(s) in ${context.path}.` }],
    isError: status !== "applied", details: {
      requestId: requestId, machineId: context.machineId, path: context.path,
      mutationId: r.mutation_id as string, status, changesExact: r.changes_exact, changes,
      // Gateway provides a bounded unified display diff, not Pi's numbered renderer.
      diff: r.diff, patch: r.diff, diffTruncated: r.diff_truncated,
      ...(firstChangedLine === undefined ? {} : { firstChangedLine }), ...(error ? { error } : {}),
    } };
}
