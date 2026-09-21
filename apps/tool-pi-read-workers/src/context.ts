import { parseExecutionGatewayContext, parseReadToolInput, parseUuid, PI_READ_RECEIVER } from "@managed-agents/contracts";
import type { ExecutionGatewayContext } from "@managed-agents/contracts";

export type ReadContext = ExecutionGatewayContext & {
  routeKey: string; sessionId: string; operationId: string; submissionId: string;
  machineId: string; path: string; offset: number | null; limit: number | null;
};
/** Paging travels in signed context so callbacks never fetch the gateway request. */
export function parseReadContext(value: unknown): ReadContext {
  const r = parseExecutionGatewayContext(value);
  if (Object.keys(r).sort().join() !== "limit,machineId,offset,operationId,path,receiver,routeKey,sessionId,submissionId"
    || r.receiver !== PI_READ_RECEIVER) throw new Error("Invalid read routing context.");
  for (const key of ["routeKey", "sessionId", "operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw new Error("Invalid read routing identifier.");
  }
  parseUuid(r.machineId);
  parseReadToolInput({ path: r.path!, ...(r.offset === null ? {} : { offset: r.offset! }), ...(r.limit === null ? {} : { limit: r.limit! }) });
  return r as ReadContext;
}
