import { parseBashInput, PI_BASH_RECEIVER } from "@managed-agents/contracts";
import type { BashSubmission, BashInput } from "@managed-agents/contracts";
import { machineSecret, object, identity, uuid, digest, routingFields, outcome, hashJson, jsonValue } from "@managed-agents/execution-gateway-protocol";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import { sha256 } from "./crypto.ts";

export interface BashContext {
  routeKey: string; sessionId: string; machineId: string; runtimeGeneration: string;
  operationId: string; submissionId: string; cwd: string; commandSha256: string;
  timeoutSeconds: number | null;
}
export function parseBashContext(value: unknown): BashContext {
  const r = object(value, ["routeKey", "sessionId", "machineId", "runtimeGeneration", "operationId", "submissionId", "cwd", "commandSha256", "timeoutSeconds"]);
  for (const key of ["operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw Error("Invalid bash correlation.");
  }
  const input = parseBashInput({ machineId: r.machineId, cwd: r.cwd, command: "", ...(r.timeoutSeconds === null ? {} : { timeout: r.timeoutSeconds }) });
  return { routeKey: identity(r.routeKey), sessionId: identity(r.sessionId), machineId: input.machineId, runtimeGeneration: uuid(r.runtimeGeneration),
    operationId: r.operationId as string,
    submissionId: r.submissionId as string, cwd: input.cwd, commandSha256: digest(r.commandSha256), timeoutSeconds: input.timeout ?? null };
}
/** Shape/binding check; the Machine DO authenticates the secret hash and version. */
export function assertSecretMatches(parsed: BashSubmission, input: BashInput): void {
  if (machineSecret(parsed.execution.token, "execution").machineId !== input.machineId) throw Error("Execution secret belongs to another machine.");
}
/** Domain separated and stable across execution-secret rotation, submission and delivery retries. */
export function bashIdentity(submissionId: string): Promise<string> { return sha256(submissionId).then(hash => `pi-bash-v1:${hash}`); }
export async function parseBashCompletion(value: unknown): Promise<{ event: CompletionEvent; context: BashContext }> {
  const raw = object(value, ["protocolVersion", "machineId", "runtimeGeneration", "requestId", "requestHash", "callback", "deliveryId", "resultHash", "outcome"]);
  if (raw.protocolVersion !== 1) throw Error("Unsupported execution completion protocol.");
  const event: CompletionEvent = { protocolVersion: 1, ...routingFields(raw), deliveryId: digest(raw.deliveryId), resultHash: digest(raw.resultHash), outcome: outcome(raw.outcome) };
  const context = parseBashContext(event.callback.context);
  if (event.callback.receiver !== PI_BASH_RECEIVER || event.machineId !== context.machineId
    || event.runtimeGeneration !== context.runtimeGeneration
    || event.requestId !== await bashIdentity(context.submissionId)
    || event.resultHash !== await hashJson(jsonValue(event.outcome))
    || event.deliveryId !== await hashJson({ requestHash: event.requestHash, resultHash: event.resultHash })) throw Error("Execution completion conflicts with bash identity or result.");
  return { event, context };
}
