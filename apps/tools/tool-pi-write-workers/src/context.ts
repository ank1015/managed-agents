import { parseWriteInput, PI_WRITE_MAX_FILE_BYTES, PI_WRITE_RECEIVER } from "@managed-agents/contracts";
import type { WriteSubmission, WriteInput } from "@managed-agents/contracts";
import { machineSecret, object, identity, uuid, integer, digest, routingFields, outcome, hashJson, jsonValue } from "@managed-agents/execution-gateway-protocol";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import { sha256 } from "./crypto.ts";

export interface WriteContext {
  routeKey: string; sessionId: string; machineId: string; runtimeGeneration: string;
  operationId: string; submissionId: string; cwd: string; path: string;
  contentSha256: string; contentBytes: number;
}
export function parseWriteContext(value: unknown): WriteContext {
  const r = object(value, ["routeKey", "sessionId", "machineId", "runtimeGeneration", "operationId", "submissionId", "cwd", "path", "contentSha256", "contentBytes"]);
  for (const key of ["operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw Error("Invalid write correlation.");
  }
  const input = parseWriteInput({ machineId: r.machineId, cwd: r.cwd, path: r.path, content: "" });
  return { routeKey: identity(r.routeKey), sessionId: identity(r.sessionId), machineId: input.machineId, runtimeGeneration: uuid(r.runtimeGeneration),
    operationId: r.operationId as string,
    submissionId: r.submissionId as string, cwd: input.cwd, path: input.path,
    contentSha256: digest(r.contentSha256), contentBytes: integer(r.contentBytes, 0, PI_WRITE_MAX_FILE_BYTES) };
}
/** Shape/binding check; the Machine DO authenticates the secret hash and version. */
export function assertSecretMatches(parsed: WriteSubmission, input: WriteInput): void {
  if (machineSecret(parsed.execution.token, "execution").machineId !== input.machineId) throw Error("Execution secret belongs to another machine.");
}
/** Domain separated and stable across execution-secret rotation, submission and delivery retries. */
export function writeIdentity(submissionId: string): Promise<string> { return sha256(submissionId).then(hash => `pi-write-v1:${hash}`); }
export async function parseWriteCompletion(value: unknown): Promise<{ event: CompletionEvent; context: WriteContext }> {
  const raw = object(value, ["protocolVersion", "machineId", "runtimeGeneration", "requestId", "requestHash", "callback", "deliveryId", "resultHash", "outcome"]);
  if (raw.protocolVersion !== 1) throw Error("Unsupported execution completion protocol.");
  const event: CompletionEvent = { protocolVersion: 1, ...routingFields(raw), deliveryId: digest(raw.deliveryId), resultHash: digest(raw.resultHash), outcome: outcome(raw.outcome) };
  const context = parseWriteContext(event.callback.context);
  if (event.callback.receiver !== PI_WRITE_RECEIVER || event.machineId !== context.machineId
    || event.runtimeGeneration !== context.runtimeGeneration
    || event.requestId !== await writeIdentity(context.submissionId)
    || event.resultHash !== await hashJson(jsonValue(event.outcome))
    || event.deliveryId !== await hashJson({ requestHash: event.requestHash, resultHash: event.resultHash })) throw Error("Execution completion conflicts with write identity or result.");
  return { event, context };
}
