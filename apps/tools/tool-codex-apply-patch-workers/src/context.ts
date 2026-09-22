import { parseExecutionGatewayUrl, parseApplyPatchInput, CODEX_APPLY_PATCH_RECEIVER } from "@managed-agents/contracts";
import type { ApplyPatchSubmission, ApplyPatchInput } from "@managed-agents/contracts";
import { machineSecret, object, identity, uuid, digest, routingFields, outcome, hashJson, jsonValue } from "@managed-agents/execution-gateway-protocol";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import { sha256 } from "./crypto.ts";

export interface ApplyPatchContext {
  routeKey: string; sessionId: string; gatewayUrl: string; machineId: string; runtimeGeneration: string;
  operationId: string; submissionId: string; cwd: string; patchSha256: string;
}
/** Signed correlation contains a digest, never patch text or credentials. */
export function parseApplyPatchContext(value: unknown): ApplyPatchContext {
  const r = object(value, ["routeKey", "sessionId", "gatewayUrl", "machineId", "runtimeGeneration", "operationId", "submissionId", "cwd", "patchSha256"]);
  for (const key of ["operationId", "submissionId"] as const) {
    if (typeof r[key] !== "string" || !r[key] || r[key].length > 2048) throw Error("Invalid apply_patch correlation.");
  }
  const input = parseApplyPatchInput({ machineId: r.machineId, cwd: r.cwd, patch: "" });
  return { gatewayUrl: parseExecutionGatewayUrl(r.gatewayUrl), routeKey: identity(r.routeKey), sessionId: identity(r.sessionId), machineId: input.machineId,
    runtimeGeneration: uuid(r.runtimeGeneration), operationId: r.operationId as string,
    submissionId: r.submissionId as string, cwd: input.cwd, patchSha256: digest(r.patchSha256) };
}
/** Shape/binding check; the Machine DO authenticates the secret hash and version. */
export function assertSecretMatches(parsed: ApplyPatchSubmission, input: ApplyPatchInput): void {
  if (machineSecret(parsed.execution.token, "execution").machineId !== input.machineId) throw Error("Execution secret belongs to another machine.");
}
/** Stable across execution-secret rotation and submission/delivery retries. */
export function applyPatchIdentity(submissionId: string): Promise<string> {
  return sha256(submissionId).then(hash => `codex-apply-patch-v1:${hash}`);
}
export async function parseApplyPatchCompletion(value: unknown): Promise<{ event: CompletionEvent; context: ApplyPatchContext }> {
  const raw = object(value, ["protocolVersion", "machineId", "runtimeGeneration", "requestId", "requestHash", "callback", "deliveryId", "resultHash", "outcome"]);
  if (raw.protocolVersion !== 1) throw Error("Unsupported execution completion protocol.");
  const event: CompletionEvent = { protocolVersion: 1, ...routingFields(raw), deliveryId: digest(raw.deliveryId), resultHash: digest(raw.resultHash), outcome: outcome(raw.outcome) };
  const context = parseApplyPatchContext(event.callback.context);
  if (event.callback.receiver !== CODEX_APPLY_PATCH_RECEIVER || event.machineId !== context.machineId
    || event.runtimeGeneration !== context.runtimeGeneration
    || event.requestId !== await applyPatchIdentity(context.submissionId)
    || event.resultHash !== await hashJson(jsonValue(event.outcome))
    || event.deliveryId !== await hashJson({ requestHash: event.requestHash, resultHash: event.resultHash })) throw Error("Execution completion conflicts with apply_patch identity or result.");
  return { event, context };
}
