import { Logger } from "@managed-agents/diagnostics";
import type { LogFields } from "@managed-agents/diagnostics";
import {
  ContractException, PI_BASH_OPERATION, PI_BASH_RECEIVER, parseBashInput, parseBashSubmission,
  parseExecutionGatewayEvent,
} from "@managed-agents/contracts";
import type { ProviderSubmitResult, GatewayEventReceipt } from "@managed-agents/contracts";
import { sha256 } from "./crypto.ts";
import { Gateway, submissionRejected, terminal, terminalOutcome } from "./gateway.ts";
import type { JobStatus } from "./gateway.ts";
import { parseBashContext } from "./context.ts";
import { withDeadline } from "./deadline.ts";
import { sessionNamespace } from "./types.ts";
import type { Env } from "./types.ts";

/** Gateway owns job idempotency and delivery retries; no local delivery ledger. */
export class BashService {
  constructor(readonly env: Env) {}
  submit(value: unknown): Promise<ProviderSubmitResult> {
    const logger = new Logger("bash-worker", this.env), started = Date.now();
    const fields: LogFields = { stage: "submit" };
    return withDeadline<ProviderSubmitResult>(async signal => {
      let parsed, input;
      try {
        parsed = parseBashSubmission(value);
        const request = parsed.submission.request;
        if (request.provider !== PI_BASH_OPERATION.provider || request.type !== PI_BASH_OPERATION.type || request.version !== PI_BASH_OPERATION.version) {
          return { status: "rejected", error: { code: "UNSUPPORTED_PI_BASH_OPERATION", message: "Expected tool-pi-bash/bash/v1." } };
        }
        input = parseBashInput(request.input);
      } catch (error) {
        if (!(error instanceof ContractException)) throw error;
        return { status: "rejected", error: { code: "INVALID_BASH_REQUEST", message: error.message } };
      }
      sessionNamespace(this.env, parsed.destination);
      const { operationId, submissionId } = parsed.submission;
      Object.assign(fields, { sessionId: parsed.destination.sessionId, operationId });
      const clientContext = { receiver: PI_BASH_RECEIVER, ...parsed.destination, operationId, submissionId,
        machineId: input.machineId, timeoutSeconds: input.timeout ?? null };
      const idempotencyKey = await gatewayKey(submissionId), gateway = new Gateway(this.env, signal);
      let job;
      try { job = await gateway.submit(input, idempotencyKey, clientContext); }
      catch (error) {
        if (!submissionRejected(error)) throw error;
        return { status: "rejected", error: { code: error.code, message: `Gateway rejected this submission (${error.code}).` } };
      }
      // Terminal replay must recover the result even if callback retries are exhausted.
      // A failed detail read is uncertain, never a definitive submission rejection.
      if (terminal(job.status)) return { status: "completed", jobId: job.id,
        outcome: await gateway.outcome({ ...job, idempotencyKey, machineId: input.machineId, clientContext }, input.timeout ?? null) };
      return { status: "accepted", jobId: job.id };
    }).then(result => {
      if (result.status === "rejected") logger.error("submission_rejected", { ...fields, errorCode: "GATEWAY_OR_CONTRACT_REJECTION", retryable: false });
      else if (result.status === "completed" && result.outcome.status === "failed") logger.error("operation_failed", {
        ...fields, gatewayJobId: result.jobId, errorCode: "UPSTREAM_OPERATION_FAILED", retryable: false });
      else logger.success("operation_submitted", { ...fields, gatewayJobId: result.jobId, outcome: result.status, durationMs: Date.now() - started });
      return result;
    }, error => {
      logger.error("submission_failed", { ...fields, errorCode: "SUBMISSION_UNCERTAIN", retryable: true, durationMs: Date.now() - started });
      throw error;
    });
  }

  /** Only the trusted signature-verifying router may bind this entrypoint. */
  acceptGatewayEvent(value: unknown): Promise<GatewayEventReceipt> {
    const started = Date.now();
    return withDeadline(async signal => {
      const event = parseExecutionGatewayEvent(value), context = parseBashContext(event.clientContext);
      if (event.machineId !== context.machineId || event.idempotencyKey !== await gatewayKey(context.submissionId)) {
        throw new Error("Gateway event conflicts with bash submission context.");
      }
      const namespace = sessionNamespace(this.env, context);
      const outcome = terminalOutcome({ id: event.jobId, status: event.type.slice(4) as JobStatus,
        machineId: event.machineId, runtimeGenerationId: event.runtimeGenerationId, idempotencyKey: event.idempotencyKey },
        event.response, event.error, context.timeoutSeconds);
      signal.throwIfAborted();
      const reply = await namespace.get(namespace.idFromName(context.sessionId)).sessionRequest({
        action: "acceptCompletion", value: { provider: "tool-pi-bash", operationId: context.operationId,
          submissionId: context.submissionId, jobId: event.jobId, outcome },
      });
      signal.throwIfAborted();
      if (!validReceipt(reply, context.operationId)) throw new Error("Session did not acknowledge durable completion admission.");
      // Failures propagate to the callback router, which owns their log.
      if (!(reply as { value: { duplicate: boolean } }).value.duplicate) {
        const logger = new Logger("bash-worker", this.env);
        const fields = {
          stage: "completion", sessionId: context.sessionId, operationId: context.operationId,
          gatewayJobId: event.jobId, outcome: outcome.status, durationMs: Date.now() - started,
        };
        // A command's nonzero exit is still a succeeded transport outcome.
        if (outcome.status === "failed") logger.error("operation_failed", { ...fields, errorCode: "UPSTREAM_OPERATION_FAILED", retryable: false });
        else logger.success("completion_admitted", fields);
      }
      return { status: "accepted", eventId: event.eventId, jobId: event.jobId, clientContext: event.clientContext };
    });
  }
}
function gatewayKey(submissionId: string): Promise<string> { return sha256(submissionId).then(hash => `pi-bash-v1:${hash}`); }
function validReceipt(value: unknown, operationId: string): boolean {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("value" in value)) return false;
  const receipt = value.value;
  return !!receipt && typeof receipt === "object" && "operationId" in receipt && receipt.operationId === operationId
    && "eventId" in receipt && receipt.eventId === `runtime:operation:${operationId}`
    && "duplicate" in receipt && typeof receipt.duplicate === "boolean";
}
