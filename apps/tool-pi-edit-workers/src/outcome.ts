import { parseOperationOutcome } from "@managed-agents/contracts";
import type { OperationOutcome, EditResult } from "@managed-agents/contracts";
import type { EditContext } from "./context.ts";
import type { Job } from "./gateway.ts";
import { formatReceipt, object, editError } from "./result.ts";

export function completed(result: EditResult): OperationOutcome { return parseOperationOutcome({ status: "succeeded", result }); }
function failure(jobId: string, code: string, message: string): OperationOutcome {
  return { status: "failed", origin: "execution", error: { code, message, details: { gatewayJobId: jobId } } };
}
/** Identical normalization for terminal POST replay and signed gateway callbacks. */
export async function terminalOutcome(job: Pick<Job, "id" | "status" | "machineId" | "runtimeGenerationId" | "idempotencyKey">,
  responseValue: unknown, errorValue: unknown, context: EditContext, signal: AbortSignal): Promise<OperationOutcome> {
  if (!["succeeded", "failed", "unknown"].includes(job.status)) throw new Error("Expected a terminal execution job.");
  if (job.status === "unknown") return failure(job.id, "EDIT_OUTCOME_UNKNOWN", "The edit outcome is unknown and the file may have changed. Inspect the file before deciding how to proceed. This operation will not be automatically replaced with a new edit.");
  if (errorValue !== null) {
    if (job.status !== "failed" || responseValue !== null) throw new Error("Gateway error conflicts with job status.");
    const error = object(errorValue);
    if (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) throw new Error("Malformed gateway error.");
    return failure(job.id, error.code.slice(0, 200), error.message.slice(0, 1000));
  }
  const response = object(responseValue);
  if (response.protocol_version !== 5 || response.request_id !== job.id || !job.runtimeGenerationId
    || response.generation_id !== job.runtimeGenerationId) throw new Error("Invalid patch response correlation/version.");
  if (response.status === "error" && job.status === "failed") {
    const error = object(response.error);
    if (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) throw new Error("Malformed filesystem error.");
    // These outer errors occur before execution. An unstructured I/O failure may be uncertain.
    if (["invalid_argument", "resource_limit"].includes(error.code)) {
      return completed(editError(context, error.code, error.message.slice(0, 2000), job.id));
    }
    return failure(job.id, error.code.slice(0, 200), error.message.slice(0, 1000));
  }
  if (response.status !== "ok") throw new Error("Invalid terminal patch response.");
  const receipt = object(response.result);
  if ((receipt.status === "applied" ? "succeeded" : "failed") !== job.status) throw new Error("Patch status conflicts with gateway job.");
  const result = await formatReceipt(receipt, context, job.id);
  signal.throwIfAborted();
  return completed(result);
}
