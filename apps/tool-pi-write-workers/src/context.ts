import { parseExecutionGatewayContext, parseWriteInput, PI_WRITE_MAX_FILE_BYTES, PI_WRITE_RECEIVER } from "@managed-agents/contracts";
import type { ExecutionGatewayContext } from "@managed-agents/contracts";
import { sha256 } from "./crypto.ts";

export type WriteContext = ExecutionGatewayContext & {
  routeKey: string; sessionId: string; operationId: string; submissionId: string;
  machineId: string; cwd: string; path: string; contentSha256: string; contentBytes: number;
};
/** Expected receipt travels in signed context; file content is never echoed in callbacks. */
export function parseWriteContext(value: unknown): WriteContext {
  const r = parseExecutionGatewayContext(value);
  if (Object.keys(r).sort().join() !== "contentBytes,contentSha256,cwd,machineId,operationId,path,receiver,routeKey,sessionId,submissionId"
    || r.receiver !== PI_WRITE_RECEIVER) throw new Error("Invalid write routing context.");
  for (const key of ["routeKey", "sessionId", "operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw new Error("Invalid write routing identifier.");
  }
  parseWriteInput({ machineId: r.machineId!, cwd: r.cwd!, path: r.path!, content: "" });
  if (typeof r.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.contentSha256)
    || typeof r.contentBytes !== "number" || !Number.isSafeInteger(r.contentBytes)
    || r.contentBytes < 0 || r.contentBytes > PI_WRITE_MAX_FILE_BYTES) throw new Error("Invalid expected write receipt.");
  return r as WriteContext;
}
/** Domain separated from other tools; stable across POST retries and callback replay. */
export function writeIdentity(submissionId: string): Promise<string> { return sha256(submissionId).then(hash => `pi-write-v1:${hash}`); }
