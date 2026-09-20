import { parseJsonValue } from "@managed-agents/contracts";

/** Host-owned routing metadata, never part of the harness's LLM input. */
export type ClientContext = { routeKey: string; sessionId: string; operationId: string; submissionId: string };
const keys = ["operationId", "routeKey", "sessionId", "submissionId"] as const;

export function parseClientContext(value: unknown): ClientContext {
  const r = parseJsonValue(value);
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).sort().join() !== keys.join()) {
    throw new Error("Invalid LLM callback context.");
  }
  for (const key of keys) {
    if (typeof r[key] !== "string" || !r[key].trim() || r[key].length > 2048) throw new Error("Invalid LLM callback identity.");
  }
  return { routeKey: r.routeKey as string, sessionId: r.sessionId as string,
    operationId: r.operationId as string, submissionId: r.submissionId as string };
}

export function sameContext(a: ClientContext, b: ClientContext): boolean {
  return keys.every(key => a[key] === b[key]);
}
