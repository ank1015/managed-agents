import type { LogFields } from "@managed-agents/diagnostics";
import { Logger } from "@managed-agents/diagnostics";
import { ContractException, PI_BASH_OPERATION, parseBashInput, parseBashSubmission } from "@managed-agents/contracts";
import type { ProviderSubmitResult } from "@managed-agents/contracts";
import type { CompletionReply } from "@managed-agents/execution-gateway-protocol";
import { sha256 } from "./crypto.ts";
import { terminalOutcome } from "./outcome.ts";
import { bashIdentity, parseBashCompletion, assertSecretMatches } from "./context.ts";
import { Gateway, GatewayError } from "./gateway.ts";
import { withDeadline, CALLBACK_BUDGET_MS } from "./deadline.ts";
import { sessionNamespace } from "./types.ts";
import type { Env } from "./types.ts";

/** Stateless adapter. Daemon journals requests/results; Session DO durably admits completion. */
export class BashService {
  constructor(readonly env: Env) {}
  submit(value: unknown): Promise<ProviderSubmitResult> {
    const logger = new Logger("bash-worker", this.env), fields: LogFields = {stage: "submit"};
    return withDeadline<ProviderSubmitResult>(async signal => {
      let parsed, input;
      try {
        parsed = parseBashSubmission(value);
        const request = parsed.submission.request;
        if (request.provider !== PI_BASH_OPERATION.provider || request.type !== PI_BASH_OPERATION.type || request.version !== PI_BASH_OPERATION.version) throw new ContractException("INVALID_REQUEST", "Expected tool-pi-bash/bash/v1.");
        input = parseBashInput(request.input);
      } catch (error) {
        if (!(error instanceof ContractException)) throw error;
        return { status: "rejected", error: { code: "INVALID_BASH_REQUEST", message: error.message } };
      }
      Object.assign(fields, {sessionId: parsed.destination.sessionId, operationId: parsed.submission.operationId});
      sessionNamespace(this.env, parsed.destination);
      // A replaceable authorization/configuration error must not finish the logical operation.
      assertSecretMatches(parsed, input);
      const { operationId, submissionId } = parsed.submission;
      const requestId = await bashIdentity(submissionId);
      const context = { ...parsed.destination, machineId: input.machineId, runtimeGeneration: parsed.execution.runtimeGeneration,
        operationId, submissionId, cwd: input.cwd, commandSha256: await sha256(input.command), timeoutSeconds: input.timeout ?? null };
      try { await new Gateway(this.env, signal).submit(input, parsed, requestId, context); }
      catch (error) {
        if (error instanceof GatewayError && !error.retryable && !error.uncertain && ![401, 403, 409].includes(error.status)) {
          return { status: "rejected", error: { code: error.code, message: error.message } };
        }
        // Lost/malformed acceptance, credential replacement, runtime fences and conflicts never authorize a fresh bash.
        throw error;
      }
      new Logger("bash-worker", this.env).success("operation_submitted", { sessionId: parsed.destination.sessionId, operationId, stage: "submit", outcome: "accepted" });
      return { status: "accepted", jobId: requestId };
    }).then(result => {
      if (result.status === "rejected") logger.error("submission_rejected", {...fields, errorCode: "GATEWAY_OR_CONTRACT_REJECTION", retryable: false});
      return result;
    }, error => {
      logger.error("submission_failed", {...fields, errorCode: "SUBMISSION_UNCERTAIN", retryable: true});
      throw error;
    });
  }
  /** Trusted Machine gateway private RPC; no legacy HMAC webhook envelope. */
  acceptExecutionResult(value: unknown): Promise<CompletionReply> {
    return withDeadline(async signal => {
      const { event, context } = await parseBashCompletion(value);
      const namespace = sessionNamespace(this.env, context);
      const outcome = await terminalOutcome(event, context);
      signal.throwIfAborted();
      const reply = await namespace.get(namespace.idFromName(context.sessionId)).sessionRequest({
        action: "acceptToolCompletion", value: { execution: { machineId: context.machineId,
          runtimeGeneration: context.runtimeGeneration }, completion: { provider: PI_BASH_OPERATION.provider, operationId: context.operationId,
          submissionId: context.submissionId, jobId: event.requestId, outcome } },
      });
      signal.throwIfAborted();
      if (!validReceipt(reply, context.operationId)) throw Error("Session did not confirm durable bash completion admission.");
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
