import { parseToolExecutionSubmission } from "./tool-execution.ts";
import type { ToolExecutionSubmission } from "./tool-execution.ts";
import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import { parseUuid } from "./llm.ts";
import type { LlmTool } from "./llm.ts";
import { isAbsoluteMachinePath } from "./pi-bash.ts";
import { nonemptyString, record } from "./validation.ts";

export const PI_EDIT_OPERATION = Object.freeze({ provider: "tool-pi-edit", type: "edit", version: "v1" });
export const PI_EDIT_RECEIVER = "tool-pi-edit-v1";
export const PI_EDIT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const PI_EDIT_MAX_EDITS = 256;
export const PI_EDIT_MAX_PARAMS_BYTES = 4 * 1024 * 1024;
export const PI_EDIT_TOOL = Object.freeze({
  type: "function", name: "edit",
  description: "Make precise edits to an existing file using exact text replacements. Each oldText must match uniquely in the original file. Edits must not overlap. Files must be at most 5 MiB before and after editing; at most 256 replacements per call.",
  parameters: {
    type: "object", properties: {
      path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
      edits: { type: "array", minItems: 1, maxItems: PI_EDIT_MAX_EDITS, items: {
        type: "object", properties: {
          oldText: { type: "string", minLength: 1, description: "Exact text, unique in the original file and disjoint from other edits" },
          newText: { type: "string", description: "Replacement text; empty to delete the matched text" },
        }, required: ["oldText", "newText"], additionalProperties: false,
      } },
    }, required: ["path", "edits"], additionalProperties: false,
  },
} satisfies LlmTool);

export type EditReplacement = { oldText: string; newText: string };
export type EditToolInput = { path: string; edits: EditReplacement[] };
export type EditInput = EditToolInput & { machineId: string; cwd: string };
export type EditSubmission = ToolExecutionSubmission;
export interface EditWorkerBinding { submit(value: unknown): Promise<unknown> }

export function parseEditToolInput(value: unknown): EditToolInput {
  const r = record(parseJsonValue(value), ["path", "edits"], "edit arguments");
  const path = nonemptyString(r.path, "path");
  if (path.includes("\0") || path.length > 8192) throw new ContractException("INVALID_REQUEST", "path must contain no NUL bytes and be at most 8192 characters.");
  if (!Array.isArray(r.edits) || r.edits.length === 0 || r.edits.length > PI_EDIT_MAX_EDITS) {
    throw new ContractException("INVALID_REQUEST", "edits must contain between 1 and 256 replacements.");
  }
  const edits = r.edits.map(value => {
    const edit = record(value, ["oldText", "newText"], "edit replacement");
    // Whitespace-only oldText is meaningful; only the empty string is invalid.
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0 || typeof edit.newText !== "string") {
      throw new ContractException("INVALID_REQUEST", "oldText must be a nonempty string and newText must be a string.");
    }
    return { oldText: edit.oldText, newText: edit.newText };
  });
  return { path, edits };
}
export function parseEditInput(value: unknown): EditInput {
  const r = record(parseJsonValue(value), ["machineId", "cwd", "path", "edits"], "edit input");
  const cwd = nonemptyString(r.cwd, "cwd");
  if (!isAbsoluteMachinePath(cwd) || cwd.length > 8192) throw new ContractException("INVALID_REQUEST", "cwd must be an absolute machine path of at most 8192 characters.");
  return { machineId: parseUuid(r.machineId), cwd, ...parseEditToolInput({ path: r.path!, edits: r.edits! }) };
}
export const parseEditSubmission = parseToolExecutionSubmission;

export type EditFileChange = { path: string; beforeSha256: string; afterSha256: string;
  bytesBefore: number; bytesAfter: number; firstChangedLine?: number };
export type EditResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
  details: {
    requestId?: string; machineId: string; path: string;
    diff?: string; patch?: string; firstChangedLine?: number; diffTruncated?: boolean;
    mutationId?: string; status?: "applied" | "rejected" | "partial"; changesExact?: boolean;
    changes?: EditFileChange[];
    error?: { code: string; message: string; section?: number; edit?: number };
  };
};
