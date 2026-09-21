import { parseExecutionGatewayContext, parseEditInput, PI_EDIT_MAX_EDITS, PI_EDIT_RECEIVER } from "@managed-agents/contracts";
import type { ExecutionGatewayContext } from "@managed-agents/contracts";
import { sha256 } from "./crypto.ts";

export type EditContext = ExecutionGatewayContext & {
  routeKey: string; sessionId: string; operationId: string; submissionId: string;
  machineId: string; cwd: string; path: string; editsSha256: string; editCount: number;
};
/** Signed correlation contains a digest, never the user's replacement text. */
export function parseEditContext(value: unknown): EditContext {
  const r = parseExecutionGatewayContext(value);
  if (Object.keys(r).sort().join() !== "cwd,editCount,editsSha256,machineId,operationId,path,receiver,routeKey,sessionId,submissionId"
    || r.receiver !== PI_EDIT_RECEIVER) throw new Error("Invalid edit routing context.");
  for (const key of ["routeKey", "sessionId", "operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw new Error("Invalid edit routing identifier.");
  }
  parseEditInput({ machineId: r.machineId!, cwd: r.cwd!, path: r.path!, edits: [{ oldText: "x", newText: "" }] });
  if (typeof r.editsSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.editsSha256)
    || typeof r.editCount !== "number" || !Number.isSafeInteger(r.editCount)
    || r.editCount < 1 || r.editCount > PI_EDIT_MAX_EDITS) throw new Error("Invalid expected edit context.");
  return r as EditContext;
}
export function editIdentity(submissionId: string): Promise<string> { return sha256(submissionId).then(hash => `pi-edit-v1:${hash}`); }
