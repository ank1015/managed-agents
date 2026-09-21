import { parseOperationOutcome } from "@managed-agents/contracts";
import type { OperationOutcome, ReadResult } from "@managed-agents/contracts";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import type { ReadContext } from "./context.ts";
import { decodeFile, fileTooLarge, formatText, readError } from "./result.ts";
import { detectImageMimeType, formatImage } from "./images.ts";
import type { Env } from "./types.ts";

export function completed(result: ReadResult): OperationOutcome { return parseOperationOutcome({ status: "succeeded", result }); }
export async function terminalOutcome(event: CompletionEvent, context: ReadContext, env: Env, signal: AbortSignal): Promise<OperationOutcome> {
  if (event.outcome.status === "error") {
    const { code, message, uncertain } = event.outcome.error;
    // The daemon conservatively marks I/O/resource errors uncertain for all operations.
    // A read has no mutation to reconcile: report its native file error to the model.
    if (["not_found", "io", "invalid_argument", "resource_limit", "conflict"].includes(code)) {
      return completed(readError(event.requestId, context, code, message.slice(0, 2000)));
    }
    return { status: "failed", origin: "execution", error: { code: uncertain ? "READ_OUTCOME_UNKNOWN" : code,
      message: uncertain ? "The read outcome is unknown; this request will not be automatically replaced with a new read." : message.slice(0, 2000),
      details: { requestId: event.requestId, nativeCode: code, uncertain } } };
  }
  const file = await decodeFile(event.outcome.result);
  signal.throwIfAborted();
  if (file === "too_large") return completed(fileTooLarge(event.requestId, context));
  const mime = detectImageMimeType(file.bytes);
  return completed(mime ? await formatImage(file, mime, event.requestId, context, env, signal) : formatText(file, event.requestId, context));
}
