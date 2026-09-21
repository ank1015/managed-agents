import { parseOperationOutcome } from "@managed-agents/contracts";
import type { OperationOutcome, WriteResult } from "@managed-agents/contracts";
import type { WriteContext } from "./context.ts";
import type { Job } from "./gateway.ts";
import { formatReceipt, object, writeError } from "./result.ts";

export function completed(result: WriteResult): OperationOutcome { return parseOperationOutcome({ status: "succeeded", result }); }
function failure(jobId: string, code: string, message: string): OperationOutcome {
  return { status: "failed", origin: "execution", error: { code, message, details: { gatewayJobId: jobId } } };
}
/** Identical normalization for terminal POST replay and signed gateway callbacks. */
export async function terminalOutcome(job: Pick<Job, "id" | "status" | "machineId" | "runtimeGenerationId" | "idempotencyKey">,
  responseValue: unknown, errorValue: unknown, context: WriteContext, signal: AbortSignal): Promise<OperationOutcome> {
  if (!["succeeded", "failed", "unknown"].includes(job.status)) throw new Error("Expected a terminal execution job.");
  if (job.status === "unknown") return failure(job.id, "WRITE_OUTCOME_UNKNOWN", "The file write outcome is unknown and the file may have changed. Inspect the file before deciding how to proceed. This operation will not be automatically replaced with a new write.");
  if (errorValue !== null) {
    if (job.status !== "failed" || responseValue !== null) throw new Error("Gateway error conflicts with job status.");
    const error = object(errorValue);
    if (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) throw new Error("Malformed gateway error.");
    return failure(job.id, error.code.slice(0, 200), error.message.slice(0, 1000));
  }
  const response = object(responseValue);
  if ((response.protocol_version !== 4 && response.protocol_version !== 5) || response.request_id !== job.id || !job.runtimeGenerationId
    || response.generation_id !== job.runtimeGenerationId) throw new Error("Invalid file response correlation/version.");
  if (response.status === "error" && job.status === "failed") {
    const error = object(response.error);
    if (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) throw new Error("Malformed filesystem error.");
    // resource_limit can mean a lower host byte cap OR exhausted mutation receipts. Preserve its message.
    if (["not_found", "io", "invalid_argument", "resource_limit"].includes(error.code)) {
      return completed(writeError(context, error.code, error.message.slice(0, 2000), job.id));
    }
    return failure(job.id, error.code.slice(0, 200), error.message.slice(0, 1000));
  }
  if (response.status !== "ok" || job.status !== "succeeded") throw new Error("Invalid terminal file response.");
  const result = await formatReceipt(response.result, context, job.id);
  signal.throwIfAborted();
  return completed(result);
}
