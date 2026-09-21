import { parseOperationOutcome } from "@managed-agents/contracts";
import type { OperationOutcome, ReadResult } from "@managed-agents/contracts";
import type { ReadContext } from "./context.ts";
import type { Job } from "./gateway.ts";
import { decodeFile, fileTooLarge, formatText, object, readError } from "./result.ts";
import { detectImageMimeType, formatImage } from "./images.ts";
import type { Env } from "./types.ts";

function completed(result: ReadResult): OperationOutcome { return parseOperationOutcome({ status: "succeeded", result }); }
function failure(jobId: string, code: string, message: string): OperationOutcome {
  return { status: "failed", origin: "execution", error: { code, message, details: { gatewayJobId: jobId } } };
}
/** Identical normalization for terminal POST replay and signed gateway callbacks. */
export async function terminalOutcome(job: Pick<Job, "id" | "status" | "machineId" | "runtimeGenerationId" | "idempotencyKey">,
  responseValue: unknown, errorValue: unknown, context: ReadContext, env: Env, signal: AbortSignal): Promise<OperationOutcome> {
  if (!["succeeded", "failed", "unknown"].includes(job.status)) throw new Error("Expected a terminal execution job.");
  if (job.status === "unknown") return failure(job.id, "READ_OUTCOME_UNKNOWN", "The file read outcome is unknown. This operation will not be automatically replaced with a new read.");
  if (errorValue !== null) {
    if (job.status !== "failed" || responseValue !== null) throw new Error("Gateway error conflicts with job status.");
    const error = object(errorValue);
    if (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) throw new Error("Malformed gateway error.");
    return failure(job.id, error.code.slice(0, 200), error.message.slice(0, 1000));
  }
  const response = object(responseValue);
  if (response.protocol_version !== 4 || response.request_id !== job.id || !job.runtimeGenerationId
    || response.generation_id !== job.runtimeGenerationId) throw new Error("Invalid file response correlation/version.");
  if (response.status === "error" && job.status === "failed") {
    const error = object(response.error);
    if (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) throw new Error("Malformed filesystem error.");
    if (error.code === "resource_limit") return completed(fileTooLarge(job.id, context));
    if (["not_found", "io", "invalid_argument"].includes(error.code)) return completed(readError(job.id, context, error.code, error.message.slice(0, 2000)));
    return failure(job.id, error.code.slice(0, 200), error.message.slice(0, 1000));
  }
  if (response.status !== "ok" || job.status !== "succeeded") throw new Error("Invalid terminal file response.");
  const file = await decodeFile(response.result);
  signal.throwIfAborted();
  if (file === "too_large") return completed(fileTooLarge(job.id, context));
  const mimeType = detectImageMimeType(file.bytes);
  return completed(mimeType ? await formatImage(file, mimeType, job.id, context, env, signal) : formatText(file, job.id, context));
}
