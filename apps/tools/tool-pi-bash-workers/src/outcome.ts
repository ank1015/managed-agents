import { parseOperationOutcome } from "@managed-agents/contracts";
import type { OperationOutcome } from "@managed-agents/contracts";
import type { CompletionEvent } from "@managed-agents/execution-gateway-protocol";
import type { BashContext } from "./context.ts";
import { formatRun } from "./result.ts";

export function terminalOutcome(event: CompletionEvent, context: BashContext): OperationOutcome {
  if (event.outcome.status === "error") {
    const { code, message, uncertain } = event.outcome.error;
    return { status: "failed", origin: "execution", error: {
      code: uncertain ? "BASH_EXECUTION_UNKNOWN" : code,
      message: uncertain ? "Command may have run, but its outcome is unknown. Do not automatically execute it again." : message.slice(0, 2000),
      details: { requestId: event.requestId, nativeCode: code, uncertain },
    } };
  }
  const result = formatRun(event.outcome.result, { requestId: event.requestId, machineId: context.machineId,
    runtimeGeneration: context.runtimeGeneration }, context.timeoutSeconds);
  if (result.details.reason === "lost") return { status: "failed", origin: "execution", error: {
    code: "BASH_EXECUTION_UNKNOWN", message: "Command outcome was lost; do not automatically execute it again.",
    details: { requestId: event.requestId, toolResult: result },
  } };
  return parseOperationOutcome({ status: "succeeded", result });
}
