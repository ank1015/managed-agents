import { Logger } from "@managed-agents/diagnostics";
import type { LogFields } from "@managed-agents/diagnostics";
import { ContractException, LLM_OPERATION, parseLlmInput, parseLlmSubmission } from "@managed-agents/contracts";
import type { OperationOutcome, ProviderSubmitResult } from "@managed-agents/contracts";
import { sha256 } from "./crypto.ts";
import type { ClientContext } from "./context.ts";
import { withDeadline } from "./deadline.ts";
import { Gateway, submissionRejected, terminal } from "./gateway.ts";
import { sessionNamespace } from "./types.ts";
import type { Env } from "./types.ts";

export interface WebhookEvent {
  eventId: string; jobId: string; type: "job.succeeded" | "job.failed" | "job.cancelled";
  completedAt: string; clientContext: ClientContext;
  outcome: OperationOutcome;
}

/** No local persistence: the gateway owns idempotency, jobs and delivery retries. */
export class LlmService {
  constructor(readonly env: Env) {}

  submit(value: unknown): Promise<ProviderSubmitResult> {
    const logger = new Logger("llm-worker", this.env), started = Date.now();
    const fields: LogFields = { stage: "submit" };
    return withDeadline<ProviderSubmitResult>(async signal => {
      let parsed, input;
      try {
        parsed = parseLlmSubmission(value);
        const request = parsed.submission.request;
        if (request.provider !== LLM_OPERATION.provider || request.type !== LLM_OPERATION.type || request.version !== LLM_OPERATION.version) {
          return { status: "rejected", error: { code: "UNSUPPORTED_LLM_OPERATION", message: "Expected llm/generate/v1." } };
        }
        input = parseLlmInput(request.input);
      } catch (error) {
        if (!(error instanceof ContractException)) throw error;
        return { status: "rejected", error: { code: "INVALID_LLM_REQUEST", message: error.message } };
      }
      sessionNamespace(this.env, parsed.destination);
      const { operationId, submissionId } = parsed.submission;
      Object.assign(fields, { sessionId: parsed.destination.sessionId, operationId });
      const clientContext = { ...parsed.destination, operationId, submissionId };
      const idempotencyKey = await gatewayKey(submissionId);
      const gateway = new Gateway(this.env, signal);
      let job;
      try { job = await gateway.submit(input, idempotencyKey, clientContext); }
      catch (error) {
        if (!submissionRejected(error)) throw error;
        return { status: "rejected", error: { code: error.code, message: `Gateway rejected this submission (${error.code}).` } };
      }
      // A replay can find a terminal job whose callback has already been acknowledged/exhausted.
      // Fetch errors here are NOT submission rejection: the gateway has accepted the job.
      if (terminal(job.status)) {
        return { status: "completed", jobId: job.id,
          outcome: await gateway.outcome({ ...job, idempotencyKey, clientContext }) };
      }
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

  /** Called under the webhook's single deadline; do not acknowledge before durable DO admission. */
  async deliver(event: WebhookEvent, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    const context = event.clientContext;
    const namespace = sessionNamespace(this.env, context);
    signal.throwIfAborted();
    const reply = await namespace.get(namespace.idFromName(context.sessionId)).sessionRequest({
      action: "acceptCompletion", value: { provider: "llm", operationId: context.operationId,
        submissionId: context.submissionId, jobId: event.jobId, outcome: event.outcome },
    });
    signal.throwIfAborted();
    if (!validReceipt(reply, context.operationId)) throw new Error("Session did not acknowledge durable completion admission.");
    if (!(reply as { value: { duplicate: boolean } }).value.duplicate) {
      const logger = new Logger("llm-worker", this.env);
      const fields = {
        stage: "completion", sessionId: context.sessionId, operationId: context.operationId,
        gatewayJobId: event.jobId, outcome: event.outcome.status, durationMs: Date.now() - started,
      };
      if (event.outcome.status === "failed") logger.error("operation_failed", { ...fields, errorCode: "UPSTREAM_OPERATION_FAILED", retryable: false });
      else logger.success("completion_admitted", fields);
    }
  }
}

function gatewayKey(submissionId: string): Promise<string> { return sha256(submissionId).then(hash => `ma-v1:${hash}`); }
function validReceipt(value: unknown, operationId: string): boolean {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("value" in value)) return false;
  const receipt = value.value;
  return !!receipt && typeof receipt === "object" && "operationId" in receipt && receipt.operationId === operationId
    && "eventId" in receipt && receipt.eventId === `runtime:operation:${operationId}`
    && "duplicate" in receipt && typeof receipt.duplicate === "boolean";
}
