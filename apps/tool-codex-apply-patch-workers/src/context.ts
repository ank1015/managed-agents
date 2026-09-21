import { parseExecutionGatewayContext, parseApplyPatchInput, CODEX_APPLY_PATCH_RECEIVER } from "@managed-agents/contracts";
import type { ExecutionGatewayContext } from "@managed-agents/contracts";
import { sha256 } from "./crypto.ts";

export type ApplyPatchContext = ExecutionGatewayContext & {
  routeKey: string; sessionId: string; operationId: string; submissionId: string;
  machineId: string; cwd: string; patchSha256: string;
};
/** Signed correlation contains a digest, never patch text. */
export function parseApplyPatchContext(value: unknown): ApplyPatchContext {
  const r = parseExecutionGatewayContext(value);
  if (Object.keys(r).sort().join() !== "cwd,machineId,operationId,patchSha256,receiver,routeKey,sessionId,submissionId"
    || r.receiver !== CODEX_APPLY_PATCH_RECEIVER) throw new Error("Invalid apply_patch routing context.");
  for (const key of ["routeKey", "sessionId", "operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw new Error("Invalid apply_patch routing identifier.");
  }
  parseApplyPatchInput({ machineId: r.machineId!, cwd: r.cwd!, patch: "" });
  if (typeof r.patchSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.patchSha256)) throw new Error("Invalid expected patch digest.");
  return r as ApplyPatchContext;
}
export function applyPatchIdentity(submissionId: string): Promise<string> {
  return sha256(submissionId).then(hash => `codex-apply-patch-v1:${hash}`);
}
