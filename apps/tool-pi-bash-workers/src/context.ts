import { parseExecutionGatewayContext, parseUuid, PI_BASH_RECEIVER, PI_BASH_MAX_TIMEOUT_MS } from "@managed-agents/contracts";
import type { ExecutionGatewayContext } from "@managed-agents/contracts";

export type BashContext = ExecutionGatewayContext & {
  routeKey: string; sessionId: string; operationId: string; submissionId: string;
  machineId: string; timeoutSeconds: number | null;
};
export function parseBashContext(value: unknown): BashContext {
  const r = parseExecutionGatewayContext(value);
  if (Object.keys(r).sort().join() !== "machineId,operationId,receiver,routeKey,sessionId,submissionId,timeoutSeconds"
    || r.receiver !== PI_BASH_RECEIVER) throw new Error("Invalid bash routing context.");
  for (const key of ["routeKey", "sessionId", "operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw new Error("Invalid bash routing identifier.");
  }
  parseUuid(r.machineId);
  if (r.timeoutSeconds !== null && (typeof r.timeoutSeconds !== "number" || r.timeoutSeconds <= 0
    || r.timeoutSeconds * 1000 > PI_BASH_MAX_TIMEOUT_MS)) throw new Error("Invalid bash timeout context.");
  return r as BashContext;
}
