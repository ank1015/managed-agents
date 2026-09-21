import { parseOperationOutcome } from "@managed-agents/contracts";
import type { OperationOutcome, ApplyPatchResult } from "@managed-agents/contracts";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import type { ApplyPatchContext } from "./context.ts";
import { formatReceipt, applyPatchError } from "./result.ts";

export function completed(result: ApplyPatchResult): OperationOutcome { return parseOperationOutcome({ status: "succeeded", result }); }
export async function terminalOutcome(event: CompletionEvent, context: ApplyPatchContext): Promise<OperationOutcome> {
  if (event.outcome.status === "error") {
    const { code, message, uncertain } = event.outcome.error;
    if (!uncertain && ["invalid_argument", "resource_limit"].includes(code)) {
      return completed(applyPatchError(context, code, message.slice(0, 2000), event.requestId));
    }
    return { status: "failed", origin: "execution", error: { code: uncertain ? "APPLY_PATCH_OUTCOME_UNKNOWN" : code,
      message: uncertain ? "The patch outcome is unknown and files may have changed. Inspect the affected files before attempting another patch; this request will not be automatically rerun." : message.slice(0, 2000),
      details: { requestId: event.requestId, nativeCode: code, uncertain } } };
  }
  return completed(await formatReceipt(event.outcome.result, context, event.requestId));
}
