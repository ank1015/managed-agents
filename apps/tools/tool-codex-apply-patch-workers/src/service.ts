import { Buffer } from "node:buffer";
import { Logger } from "@managed-agents/diagnostics";
import { ContractException, CODEX_APPLY_PATCH_OPERATION, CODEX_APPLY_PATCH_MAX_PARAMS_BYTES, CODEX_APPLY_PATCH_MAX_TEXT_BYTES, parseApplyPatchInput, parseApplyPatchSubmission } from "@managed-agents/contracts";
import type { ProviderSubmitResult } from "@managed-agents/contracts";
import type { CompletionReply } from "@managed-agents/execution-gateway-protocol";
import { sha256 } from "./crypto.ts";
import { completed, terminalOutcome } from "./outcome.ts";
import { requestTooLarge } from "./result.ts";
import { applyPatchIdentity, parseApplyPatchCompletion, assertSecretMatches } from "./context.ts";
import { Gateway, GatewayError, patchParams } from "./gateway.ts";
import { withDeadline, CALLBACK_BUDGET_MS } from "./deadline.ts";
import { sessionNamespace } from "./types.ts";
import type { Env } from "./types.ts";

/** Stateless adapter. Daemon journals requests/results; Session DO durably admits completion. */
export class ApplyPatchService {
  constructor(readonly env: Env) {}
  submit(value: unknown): Promise<ProviderSubmitResult> {
    return withDeadline(async signal => {
      let parsed, input;
      try {
        parsed = parseApplyPatchSubmission(value);
        const request = parsed.submission.request;
        if (request.provider !== CODEX_APPLY_PATCH_OPERATION.provider || request.type !== CODEX_APPLY_PATCH_OPERATION.type || request.version !== CODEX_APPLY_PATCH_OPERATION.version) throw new ContractException("INVALID_REQUEST", "Expected tool-codex-apply-patch/apply_patch/v1.");
        input = parseApplyPatchInput(request.input);
      } catch (error) {
        if (!(error instanceof ContractException)) throw error;
        return { status: "rejected", error: { code: "INVALID_APPLY_PATCH_REQUEST", message: error.message } };
      }
      sessionNamespace(this.env, parsed.destination);
      // A replaceable authorization/configuration error must not finish the logical operation.
      assertSecretMatches(parsed, input);
      const { operationId, submissionId } = parsed.submission;
      const requestId = await applyPatchIdentity(submissionId);
      if (Buffer.byteLength(input.patch, "utf8") > CODEX_APPLY_PATCH_MAX_TEXT_BYTES || Buffer.byteLength(JSON.stringify(patchParams(input)), "utf8") > CODEX_APPLY_PATCH_MAX_PARAMS_BYTES) return { status: "completed", jobId: `local:${requestId}`, outcome: completed(requestTooLarge(input)) };
      const context = { ...parsed.destination, gatewayUrl: parsed.execution.gatewayUrl, machineId: input.machineId, runtimeGeneration: parsed.execution.runtimeGeneration,
        operationId, submissionId, cwd: input.cwd, patchSha256: await sha256(input.patch) };
      try { await new Gateway(parsed.execution.gatewayUrl, signal).submit(input, parsed, requestId, context); }
      catch (error) {
        if (error instanceof GatewayError && !error.retryable && !error.uncertain && ![401, 403, 409].includes(error.status)) {
          return { status: "rejected", error: { code: error.code, message: error.message } };
        }
        // Lost/malformed acceptance, credential replacement, runtime fences and conflicts never authorize a fresh patch.
        throw error;
      }
      new Logger("apply-patch-worker", this.env).success("operation_submitted", { sessionId: parsed.destination.sessionId, operationId, stage: "submit", outcome: "accepted" });
      return { status: "accepted", jobId: requestId };
    });
  }
  /** Trusted Machine gateway private RPC. */
  acceptExecutionResult(value: unknown): Promise<CompletionReply> {
    return withDeadline(async signal => {
      const { event, context } = await parseApplyPatchCompletion(value);
      const namespace = sessionNamespace(this.env, context);
      const outcome = await terminalOutcome(event, context);
      signal.throwIfAborted();
      const reply = await namespace.get(namespace.idFromName(context.sessionId)).sessionRequest({
        action: "acceptToolCompletion", value: { execution: { gatewayUrl: context.gatewayUrl, machineId: context.machineId,
          runtimeGeneration: context.runtimeGeneration }, completion: { provider: CODEX_APPLY_PATCH_OPERATION.provider, operationId: context.operationId,
          submissionId: context.submissionId, jobId: event.requestId, outcome } },
      });
      signal.throwIfAborted();
      if (!validReceipt(reply, context.operationId)) throw Error("Session did not confirm durable patch completion admission.");
      return { status: "accepted", deliveryId: event.deliveryId, requestId: event.requestId, requestHash: event.requestHash, resultHash: event.resultHash };
    }, CALLBACK_BUDGET_MS);
  }
}
function validReceipt(value: unknown, operationId: string): boolean {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("value" in value)) return false;
  const receipt = value.value;
  return !!receipt && typeof receipt === "object" && "operationId" in receipt && receipt.operationId === operationId
    && "eventId" in receipt && receipt.eventId === `runtime:operation:${operationId}` && "duplicate" in receipt && typeof receipt.duplicate === "boolean";
}
