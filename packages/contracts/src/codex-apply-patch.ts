import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import { parseProviderSubmission } from "./operation.ts";
import type { ProviderSubmission } from "./operation.ts";
import { parseUuid } from "./llm.ts";
import type { LlmTool, SessionDestination } from "./llm.ts";
import { isAbsoluteMachinePath } from "./pi-bash.ts";
import { nonemptyString, record } from "./validation.ts";

export const CODEX_APPLY_PATCH_OPERATION = Object.freeze({ provider: "tool-codex-apply-patch", type: "apply_patch", version: "v1" });
export const CODEX_APPLY_PATCH_RECEIVER = "tool-codex-apply-patch-v1";
export const CODEX_APPLY_PATCH_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const CODEX_APPLY_PATCH_MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const CODEX_APPLY_PATCH_MAX_PARAMS_BYTES = 4 * 1024 * 1024;
export const CODEX_APPLY_PATCH_MAX_SECTIONS = 32;
export const CODEX_APPLY_PATCH_MAX_EDITS = 256;

// Grammar from OpenAI Codex (Apache-2.0), core/assets/tools/apply_patch.lark.
export const CODEX_APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;
export const CODEX_APPLY_PATCH_TOOL = Object.freeze({
  type: "custom", name: "apply_patch",
  description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON. Patch text must be at most 2 MiB; files at most 5 MiB before and after changes; at most 32 sections and 256 hunks per call.",
  format: { syntax: "lark", definition: CODEX_APPLY_PATCH_GRAMMAR },
} satisfies LlmTool);

export type ApplyPatchToolInput = string;
export type ApplyPatchInput = { machineId: string; cwd: string; patch: string };
export interface ApplyPatchSubmission { destination: SessionDestination; submission: ProviderSubmission }
export interface ApplyPatchWorkerBinding { submit(value: unknown): Promise<unknown> }

/** Preserve raw custom-tool input, including whitespace. The daemon validates patch syntax. */
export function parseApplyPatchToolInput(value: unknown): ApplyPatchToolInput {
  if (typeof value !== "string") throw new ContractException("INVALID_REQUEST", "apply_patch input must be raw patch text.");
  return value;
}
export function parseApplyPatchInput(value: unknown): ApplyPatchInput {
  const r = record(parseJsonValue(value), ["machineId", "cwd", "patch"], "apply_patch input");
  const cwd = nonemptyString(r.cwd, "cwd");
  if (!isAbsoluteMachinePath(cwd) || cwd.length > 8192) throw new ContractException("INVALID_REQUEST", "cwd must be an absolute machine path of at most 8192 characters.");
  return { machineId: parseUuid(r.machineId), cwd, patch: parseApplyPatchToolInput(r.patch) };
}
export function parseApplyPatchSubmission(value: unknown): ApplyPatchSubmission {
  const r = record(parseJsonValue(value), ["destination", "submission"], "apply_patch submission");
  const d = record(r.destination, ["routeKey", "sessionId"], "destination");
  const destination = { routeKey: nonemptyString(d.routeKey, "routeKey"), sessionId: nonemptyString(d.sessionId, "sessionId") };
  const submission = parseProviderSubmission(r.submission);
  for (const id of [destination.routeKey, destination.sessionId, submission.operationId, submission.submissionId]) {
    if (id.length > 2048) throw new ContractException("INVALID_REQUEST", "Operation routing identifier is too long.");
  }
  return { destination, submission };
}

export type ApplyPatchFileChange = {
  kind: "add" | "update" | "delete" | "move";
  path: string; destinationPath?: string;
  beforeSha256: string | null; afterSha256: string | null;
  bytesBefore: number | null; bytesAfter: number | null;
  destinationBeforeSha256?: string | null; destinationBytesBefore?: number | null;
  firstChangedLine?: number;
};
export type ApplyPatchResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
  details: {
    gatewayJobId?: string; machineId: string;
    diff?: string; diffTruncated?: boolean; summaryTruncated?: boolean;
    mutationId?: string; status?: "applied" | "rejected" | "partial"; changesExact?: boolean;
    changes?: ApplyPatchFileChange[];
    error?: { code: string; message: string; section?: number; edit?: number };
  };
};
