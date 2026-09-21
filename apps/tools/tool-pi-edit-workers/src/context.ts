import { parseEditInput, PI_EDIT_MAX_EDITS, PI_EDIT_RECEIVER } from "@managed-agents/contracts";
import type { EditSubmission, EditInput } from "@managed-agents/contracts";
import { machineSecret, object, identity, uuid, integer, digest, routingFields, outcome, hashJson, jsonValue } from "@managed-agents/execution-gateway-protocol";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import { sha256 } from "./crypto.ts";

export interface EditContext {
  routeKey: string; sessionId: string; machineId: string; runtimeGeneration: string;
  operationId: string; submissionId: string; cwd: string; path: string;
  editsSha256: string; editCount: number;
}
export function parseEditContext(value: unknown): EditContext {
  const r = object(value, ["routeKey", "sessionId", "machineId", "runtimeGeneration", "operationId", "submissionId", "cwd", "path", "editsSha256", "editCount"]);
  for (const key of ["operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw Error("Invalid edit correlation.");
  }
  const input = parseEditInput({ machineId: r.machineId, cwd: r.cwd, path: r.path, edits: [{oldText: "x", newText: ""}] });
  return { routeKey: identity(r.routeKey), sessionId: identity(r.sessionId), machineId: input.machineId, runtimeGeneration: uuid(r.runtimeGeneration),
    operationId: r.operationId as string,
    submissionId: r.submissionId as string, cwd: input.cwd, path: input.path,
    editsSha256: digest(r.editsSha256), editCount: integer(r.editCount, 1, PI_EDIT_MAX_EDITS) };
}
/** Shape/binding check; the Machine DO authenticates the secret hash and version. */
export function assertSecretMatches(parsed: EditSubmission, input: EditInput): void {
  if (machineSecret(parsed.execution.token, "execution").machineId !== input.machineId) throw Error("Execution secret belongs to another machine.");
}
/** Domain separated and stable across execution-secret rotation, submission and delivery retries. */
export function editIdentity(submissionId: string): Promise<string> { return sha256(submissionId).then(hash => `pi-edit-v1:${hash}`); }
export async function parseEditCompletion(value: unknown): Promise<{ event: CompletionEvent; context: EditContext }> {
  const raw = object(value, ["protocolVersion", "machineId", "runtimeGeneration", "requestId", "requestHash", "callback", "deliveryId", "resultHash", "outcome"]);
  if (raw.protocolVersion !== 1) throw Error("Unsupported execution completion protocol.");
  const event: CompletionEvent = { protocolVersion: 1, ...routingFields(raw), deliveryId: digest(raw.deliveryId), resultHash: digest(raw.resultHash), outcome: outcome(raw.outcome) };
  const context = parseEditContext(event.callback.context);
  if (event.callback.receiver !== PI_EDIT_RECEIVER || event.machineId !== context.machineId
    || event.runtimeGeneration !== context.runtimeGeneration
    || event.requestId !== await editIdentity(context.submissionId)
    || event.resultHash !== await hashJson(jsonValue(event.outcome))
    || event.deliveryId !== await hashJson({ requestHash: event.requestHash, resultHash: event.resultHash })) throw Error("Execution completion conflicts with edit identity or result.");
  return { event, context };
}
