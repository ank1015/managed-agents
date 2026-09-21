import { parseReadInput, PI_READ_RECEIVER } from "@managed-agents/contracts";
import type { ReadSubmission, ReadInput } from "@managed-agents/contracts";
import { machineSecret, object, identity, uuid, digest, routingFields, outcome, hashJson, jsonValue } from "@managed-agents/execution-gateway-protocol";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import { sha256 } from "./crypto.ts";

export interface ReadContext {
  routeKey: string; sessionId: string; machineId: string; runtimeGeneration: string;
  operationId: string; submissionId: string; cwd: string; path: string;
  offset: number | null; limit: number | null;
}
export function parseReadContext(value: unknown): ReadContext {
  const r = object(value, ["routeKey", "sessionId", "machineId", "runtimeGeneration", "operationId", "submissionId", "cwd", "path", "offset", "limit"]);
  for (const key of ["operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw Error("Invalid read correlation.");
  }
  const input = parseReadInput({ machineId: r.machineId, cwd: r.cwd, path: r.path, ...(r.offset === null ? {} : { offset: r.offset }), ...(r.limit === null ? {} : { limit: r.limit }) });
  return { routeKey: identity(r.routeKey), sessionId: identity(r.sessionId), machineId: input.machineId, runtimeGeneration: uuid(r.runtimeGeneration),
    operationId: r.operationId as string,
    submissionId: r.submissionId as string, cwd: input.cwd, path: input.path,
    offset: input.offset ?? null, limit: input.limit ?? null };
}
/** Shape/binding check; the Machine DO authenticates the secret hash and version. */
export function assertSecretMatches(parsed: ReadSubmission, input: ReadInput): void {
  if (machineSecret(parsed.execution.token, "execution").machineId !== input.machineId) throw Error("Execution secret belongs to another machine.");
}
/** Domain separated and stable across execution-secret rotation, submission and delivery retries. */
export function readIdentity(submissionId: string): Promise<string> { return sha256(submissionId).then(hash => `pi-read-v1:${hash}`); }
export async function parseReadCompletion(value: unknown): Promise<{ event: CompletionEvent; context: ReadContext }> {
  const raw = object(value, ["protocolVersion", "machineId", "runtimeGeneration", "requestId", "requestHash", "callback", "deliveryId", "resultHash", "outcome"]);
  if (raw.protocolVersion !== 1) throw Error("Unsupported execution completion protocol.");
  const event: CompletionEvent = { protocolVersion: 1, ...routingFields(raw), deliveryId: digest(raw.deliveryId), resultHash: digest(raw.resultHash), outcome: outcome(raw.outcome) };
  const context = parseReadContext(event.callback.context);
  if (event.callback.receiver !== PI_READ_RECEIVER || event.machineId !== context.machineId
    || event.runtimeGeneration !== context.runtimeGeneration
    || event.requestId !== await readIdentity(context.submissionId)
    || event.resultHash !== await hashJson(jsonValue(event.outcome))
    || event.deliveryId !== await hashJson({ requestHash: event.requestHash, resultHash: event.resultHash })) throw Error("Execution completion conflicts with read identity or result.");
  return { event, context };
}
