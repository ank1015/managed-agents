import { isAbsoluteMachinePath, CODEX_APPLY_PATCH_MAX_FILE_BYTES, CODEX_APPLY_PATCH_MAX_SECTIONS, CODEX_APPLY_PATCH_MAX_EDITS, utf8Bytes } from "@managed-agents/contracts";
import type { JsonValue, ApplyPatchFileChange, ApplyPatchResult } from "@managed-agents/contracts";
import type { ApplyPatchContext } from "./context.ts";
import { applyPatchIdentity } from "./context.ts";

export function object(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, JsonValue>;
}
export function applyPatchError(context: Pick<ApplyPatchContext, "machineId">, code: string, message: string, requestId?: string): ApplyPatchResult {
  return { content: [{ type: "text", text: message }], isError: true,
    details: { ...(requestId === undefined ? {} : { requestId: requestId }), machineId: context.machineId, error: { code, message } } };
}
export function requestTooLarge(context: Pick<ApplyPatchContext, "machineId">): ApplyPatchResult {
  return applyPatchError(context, "APPLY_PATCH_REQUEST_TOO_LARGE", "Patch request is too big. Patch text must be at most 2 MiB and serialized patch parameters at most 4 MiB. No patch was submitted.");
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function path(value: unknown): value is string {
  return typeof value === "string" && utf8Bytes(value) <= 4096 && isAbsoluteMachinePath(value);
}
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function filePair(digest: unknown, bytes: unknown): boolean {
  return digest === null ? bytes === null : hash(digest) && integer(bytes, 0, CODEX_APPLY_PATCH_MAX_FILE_BYTES);
}
function change(value: unknown): ApplyPatchFileChange {
  const r = object(value);
  if (!["add", "update", "delete", "move"].includes(r.kind as string) || !path(r.path)
    || !filePair(r.before_sha256, r.bytes_before) || !filePair(r.after_sha256, r.bytes_after)
    || (r.first_changed_line !== null && !integer(r.first_changed_line, 1, CODEX_APPLY_PATCH_MAX_FILE_BYTES + 1))) {
    throw new Error("Invalid filesystem patch change.");
  }
  if (r.kind === "move") {
    if (!path(r.destination_path) || r.destination_path === r.path
      || !((r.destination_before_sha256 === undefined && r.destination_bytes_before === undefined)
        || filePair(r.destination_before_sha256, r.destination_bytes_before))
      || r.before_sha256 === null || r.after_sha256 === null) throw new Error("Invalid patch move.");
  } else if ((r.destination_path !== undefined && r.destination_path !== null)
    || (r.destination_before_sha256 !== undefined && r.destination_before_sha256 !== null)
    || (r.destination_bytes_before !== undefined && r.destination_bytes_before !== null)) {
    throw new Error("Unexpected patch move metadata.");
  }
  if ((r.kind === "add" && r.after_sha256 === null)
    || (r.kind === "update" && (r.before_sha256 === null || r.after_sha256 === null))
    || (r.kind === "delete" && (r.before_sha256 === null || r.after_sha256 !== null))) {
    throw new Error("Patch change conflicts with file metadata.");
  }
  return { kind: r.kind as ApplyPatchFileChange["kind"], path: r.path,
    beforeSha256: r.before_sha256 as string | null, afterSha256: r.after_sha256 as string | null,
    bytesBefore: r.bytes_before as number | null, bytesAfter: r.bytes_after as number | null,
    ...(r.kind === "move" ? { destinationPath: r.destination_path as string,
      destinationBeforeSha256: (r.destination_before_sha256 ?? null) as string | null,
      destinationBytesBefore: (r.destination_bytes_before ?? null) as number | null } : {}),
    ...(r.first_changed_line === null ? {} : { firstChangedLine: r.first_changed_line as number }) };
}
/** Codex groups A/M/D summaries; moves appear as M at the destination. Keep ordered receipts separately. */
function summary(changes: ApplyPatchFileChange[], success: boolean) {
  let text = success ? "Success. Updated the following files:\n" : "Known file changes before failure:\n";
  const ordered = success ? [changes.filter(c => c.kind === "add"), changes.filter(c => c.kind === "update" || c.kind === "move"), changes.filter(c => c.kind === "delete")].flat() : changes;
  for (const c of ordered) {
    // Escape control characters so filenames cannot inject extra summary lines.
    const name = (c.destinationPath ?? c.path).replace(/[\u0000-\u001f\u007f]/g, ch => JSON.stringify(ch).slice(1, -1));
    const line = `${c.kind === "add" ? "A" : c.kind === "delete" ? "D" : "M"} ${name}\n`;
    if (utf8Bytes(text + line) > 16 * 1024) return { text: text + "[File summary truncated; see structured changes.]\n", truncated: true };
    text += line;
  }
  return { text, truncated: false };
}
/** The native runtime owns parsing/matching; signed context and mutation identity bind the receipt. */
export async function formatReceipt(value: unknown, context: ApplyPatchContext, requestId: string): Promise<ApplyPatchResult> {
  const r = object(value);
  if (r.mutation_id !== await applyPatchIdentity(context.submissionId)
    || !["applied", "rejected", "partial"].includes(r.status as string)
    || typeof r.changes_exact !== "boolean" || !Array.isArray(r.changes) || r.changes.length > CODEX_APPLY_PATCH_MAX_SECTIONS
    || typeof r.diff !== "string" || utf8Bytes(r.diff) > 64 * 1024 || typeof r.diff_truncated !== "boolean") {
    throw new Error("Filesystem patch receipt conflicts with submission.");
  }
  const changes = r.changes.map(change), status = r.status as "applied" | "rejected" | "partial";
  if ((status === "applied" && (!r.changes_exact || changes.length === 0 || r.error !== null))
    || (status === "rejected" && (!r.changes_exact || changes.length !== 0 || r.diff !== "" || r.diff_truncated))
    || (status === "partial" && r.changes_exact && changes.length === 0)) throw new Error("Inconsistent filesystem patch status.");
  let error: NonNullable<ApplyPatchResult["details"]["error"]> | undefined;
  if (status !== "applied") {
    const e = object(r.error);
    if (typeof e.code !== "string" || !/^[a-z_]{1,100}$/.test(e.code)
      || typeof e.message !== "string" || !e.message
      || (e.section !== null && !integer(e.section, 0, CODEX_APPLY_PATCH_MAX_SECTIONS - 1))
      || (e.edit !== null && !integer(e.edit, 0, CODEX_APPLY_PATCH_MAX_EDITS - 1))) throw new Error("Invalid filesystem patch error.");
    error = { code: e.code, message: e.message.slice(0, 2000),
      ...(e.section === null ? {} : { section: e.section as number }),
      ...(e.edit === null ? {} : { edit: e.edit as number }) };
  }
  const report = summary(changes, status === "applied");
  const text = status === "applied" ? report.text : status === "rejected" ? error!.message
    : `The patch did not finish and files may have changed. Inspect the affected files before attempting another patch. ${error!.message}\n${changes.length ? report.text : "No committed file changes could be confirmed.\n"}`;
  return { content: [{ type: "text", text }], isError: status !== "applied", details: {
    requestId, machineId: context.machineId, mutationId: r.mutation_id as string,
    status, changesExact: r.changes_exact, changes, diff: r.diff, diffTruncated: r.diff_truncated,
    summaryTruncated: report.truncated, ...(error ? { error } : {}),
  } };
}
