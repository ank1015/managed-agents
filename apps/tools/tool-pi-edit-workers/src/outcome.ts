import { parseOperationOutcome } from "@managed-agents/contracts";
import type { OperationOutcome, EditResult } from "@managed-agents/contracts";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import type { EditContext } from "./context.ts";
import { formatReceipt, editError } from "./result.ts";

export function completed(result: EditResult): OperationOutcome { return parseOperationOutcome({ status: "succeeded", result }); }
export async function terminalOutcome(event: CompletionEvent, context: EditContext): Promise<OperationOutcome> {
  if (event.outcome.status === "error") {
    const { code, message, uncertain } = event.outcome.error;
    if (!uncertain && ["not_found", "io", "invalid_argument", "resource_limit", "conflict"].includes(code)) {
      return completed(editError(context, code, message.slice(0, 2000), event.requestId));
    }
    return { status: "failed", origin: "execution", error: { code: uncertain ? "EDIT_OUTCOME_UNKNOWN" : code,
      message: uncertain ? "The file may have changed before execution stopped. Inspect it before issuing a new edit; this request will not be automatically rerun." : message.slice(0, 2000),
      details: { requestId: event.requestId, nativeCode: code, uncertain } } };
  }
  return completed(await formatReceipt(event.outcome.result, context, event.requestId));
}
