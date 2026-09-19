import { ContractException, LLM_OPERATION, PI_BASH_OPERATION, parseBashToolInput, parseJsonValue, parseLlmMessage, parseLlmResponse, parseOperationRequest } from "@managed-agents/contracts";
import type { InputEnvelope, JsonValue, LlmAssistantMessage, LlmMessage, OperationOutcome, RuntimeEvent } from "@managed-agents/contracts";
import type { HarnessContext, HarnessDefinition } from "@managed-agents/harness-api";
import { MINIMAL_BASH_IDENTITY, parseMinimalBashConfig, parseMinimalBashInput } from "./contracts.ts";
import type { MinimalBashConfig, MinimalBashInput } from "./contracts.ts";
import { minimalBashMigrations } from "./migrations.ts";
import { HarnessFailure, buildLlmInput, toolCalls } from "./openai.ts";
import { appendMessage, readState, readMessageJson, storeMessageJson, deleteMessageJson } from "./state.ts";
import type { State } from "./state.ts";

export const SYSTEM_PROMPT = "You are a coding agent. Help the user inspect, understand, modify, and test code using the bash tool. "
  + "Only bash is available. Each invocation is an independent shell starting in the configured working directory; shell state does not persist. "
  + "Use tool results as evidence, do not claim unperformed actions, and provide a concise final explanation of your changes and checks.";
type Context = HarnessContext<MinimalBashConfig>;
type Input = InputEnvelope<MinimalBashInput | RuntimeEvent>;

function save(ctx: Context, s: State): void {
  ctx.sql.exec(`UPDATE minimal_bash_state SET phase = ?, run_id = ?, active_operation_id = ?,
    active_assistant_sequence = ?, next_tool_index = ?, turn_count = ?, cancel_requested = ?, last_error_json = ? WHERE singleton = 1`,
    s.phase, s.run_id, s.active_operation_id, s.active_assistant_sequence, s.next_tool_index, s.turn_count, s.cancel_requested, s.last_error_json).toArray();
}
function lifecycle(ctx: Context, s: State, tag: string, data: JsonValue, eventId?: string): void {
  appendMessage(ctx.sql, { role: "custom", tag: `minimal_bash.${tag}`, data }, s.run_id,
    { inContext: false, ...(eventId === undefined ? {} : { eventId }) });
}
function fail(ctx: Context, s: State, error: HarnessFailure): void {
  s.phase = "failed"; s.active_operation_id = null; s.active_assistant_sequence = null; s.next_tool_index = 0;
  s.last_error_json = JSON.stringify({ code: error.code, message: error.message }); s.cancel_requested = 0;
  lifecycle(ctx, s, "run_failed", JSON.parse(s.last_error_json) as JsonValue);
}
function promoteSteering(ctx: Context, s: State): number {
  let count = 0;
  for (const row of ctx.sql.exec<{ event_id: string; message_json: string }>(
    "SELECT event_id, message_json FROM minimal_bash_pending_messages ORDER BY input_sequence")) {
    appendMessage(ctx.sql, readMessageJson<LlmMessage>(ctx.sql, row.message_json), s.run_id, { eventId: row.event_id });
    deleteMessageJson(ctx.sql, row.message_json); count++;
  }
  ctx.sql.exec("DELETE FROM minimal_bash_pending_messages").toArray();
  return count;
}
function requestLlm(ctx: Context, s: State): void {
  const input = buildLlmInput(ctx.sql, ctx.config, ctx.session.sessionId);
  s.active_operation_id = ctx.requestOperation({ ...LLM_OPERATION, input });
  s.phase = "llm"; s.turn_count++; s.active_assistant_sequence = null; s.next_tool_index = 0;
}
function finishTurn(ctx: Context, s: State, hadTools: boolean): void {
  s.active_operation_id = null; s.active_assistant_sequence = null; s.next_tool_index = 0;
  if (s.cancel_requested) {
    s.phase = "cancelled"; s.cancel_requested = 0;
    lifecycle(ctx, s, "run_cancelled", { mode: "after_turn", executionTerminated: false });
    return;
  }
  const inserted = promoteSteering(ctx, s);
  if (hadTools || inserted) requestLlm(ctx, s);
  else { s.phase = "idle"; lifecycle(ctx, s, "run_finished", { turns: s.turn_count }); }
}
function currentCalls(ctx: Context, s: State) {
  if (s.active_assistant_sequence === null) throw new Error("Missing active assistant message.");
  const row = ctx.sql.exec<{ message_json: string }>("SELECT message_json FROM minimal_bash_messages WHERE sequence = ?", s.active_assistant_sequence).one();
  return toolCalls(readMessageJson<LlmAssistantMessage>(ctx.sql, row.message_json));
}
function toolResult(ctx: Context, s: State, callId: string, content: JsonValue, error: string | null, details: JsonValue, operationId?: string): void {
  const message = parseLlmMessage({ role: "tool_result", toolName: "bash", toolCallId: callId, content, details,
    outcome: error === null ? { status: "success" } : { status: "error", error: { name: "BashError", message: error } } });
  appendMessage(ctx.sql, message, s.run_id, operationId === undefined ? {} : { operationId });
}
function errorResult(ctx: Context, s: State, callId: string, message: string, details: JsonValue = {}, operationId?: string): void {
  toolResult(ctx, s, callId, [{ type: "text", text: message }], message, details, operationId);
}
function advanceTools(ctx: Context, s: State): void {
  const calls = currentCalls(ctx, s);
  while (s.next_tool_index < calls.length) {
    const call = calls[s.next_tool_index]!;
    let request;
    try {
      const args = parseBashToolInput(JSON.parse(call.arguments));
      request = parseOperationRequest({ ...PI_BASH_OPERATION, input: { ...args, machineId: ctx.config.machineId, cwd: ctx.config.cwd } });
    }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof ContractException)) throw error;
      errorResult(ctx, s, call.callId, `Invalid bash arguments: ${error.message}`, { executed: false });
      s.next_tool_index++; continue;
    }
    s.active_operation_id = ctx.requestOperation(request);
    s.phase = "bash"; return;
  }
  finishTurn(ctx, s, true);
}
function completeLlm(ctx: Context, s: State, outcome: OperationOutcome, operationId: string): void {
  if (outcome.status !== "succeeded") throw new HarnessFailure("LLM_FAILED", outcome.status === "failed" ? outcome.error.message : "LLM operation was cancelled upstream.");
  let response;
  try {
    const value = outcome.result;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.gatewayJobId !== "string") throw new Error("Expected a gateway response.");
    response = parseLlmResponse(value.response);
  } catch (error) { throw new HarnessFailure("INVALID_LLM_RESPONSE", error instanceof Error ? error.message : "Malformed LLM response."); }
  const { message, ...metadata } = response;
  const row = appendMessage(ctx.sql, message, s.run_id, { inContext: false, operationId,
    responseMetadata: parseJsonValue({ ...metadata, gatewayJobId: (outcome.result as { gatewayJobId: string }).gatewayJobId }) });
  if (message.provider !== "openai" || response.modelId !== ctx.config.modelId) throw new HarnessFailure("LLM_MODEL_MISMATCH", "Response does not match the configured provider/model.");
  if (response.stopReason === "length" || response.stopReason === "content_filter" || response.stopReason === "pause_turn") {
    throw new HarnessFailure("LLM_INCOMPLETE", `Model stopped with ${response.stopReason}; no tool calls were executed. The response is retained outside model context.`);
  }
  const calls = toolCalls(message);
  if ((response.stopReason === "tool_use") !== (calls.length > 0)) throw new HarnessFailure("INVALID_LLM_RESPONSE", "Tool calls and stop reason disagree.");
  ctx.sql.exec("UPDATE minimal_bash_messages SET in_context = 1 WHERE sequence = ?", row).toArray();
  s.active_operation_id = null;
  if (calls.length) { s.active_assistant_sequence = row; s.next_tool_index = 0; advanceTools(ctx, s); }
  else finishTurn(ctx, s, false);
}
function completeBash(ctx: Context, s: State, outcome: OperationOutcome, operationId: string): void {
  const calls = currentCalls(ctx, s), call = calls[s.next_tool_index];
  if (!call) throw new Error("Missing active bash call.");
  let failure: HarnessFailure | undefined;
  if (outcome.status === "succeeded") {
    try {
      const result = outcome.result;
      if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.isError !== "boolean"
        || !Array.isArray(result.content) || result.content.some(part => !part || typeof part !== "object" || Array.isArray(part) || part.type !== "text" || typeof part.text !== "string")
        || !result.details || typeof result.details !== "object" || Array.isArray(result.details)) throw new Error("Malformed bash result.");
      toolResult(ctx, s, call.callId, result.content, result.isError ? "Bash command failed; see tool output." : null, result.details, operationId);
      if (result.details.reason === "lost") failure = new HarnessFailure("BASH_EXECUTION_UNKNOWN", "Execution outcome is unknown. Inspect the machine before explicitly resuming; the command will not be automatically rerun.");
    } catch (error) {
      if (!(error instanceof ContractException) && !(error instanceof Error && error.message === "Malformed bash result.")) throw error;
      failure = new HarnessFailure("INVALID_BASH_RESULT", "Bash result could not be validated. Execution may have occurred; inspect the machine before resuming.");
      errorResult(ctx, s, call.callId, failure.message, { outcomeUnknown: true }, operationId);
    }
  } else {
    failure = new HarnessFailure(outcome.status === "failed" ? outcome.error.code : "BASH_CANCELLED", outcome.status === "failed" ? outcome.error.message : "Bash operation was cancelled upstream.");
    errorResult(ctx, s, call.callId, failure.message, parseJsonValue(outcome), operationId);
  }
  s.active_operation_id = null; s.next_tool_index++;
  if (failure) {
    for (const skipped of calls.slice(s.next_tool_index)) errorResult(ctx, s, skipped.callId, "Not executed: the preceding bash operation could not be safely completed.", { executed: false });
    throw failure;
  }
  // A stop request deliberately does not skip calls in the current model turn.
  advanceTools(ctx, s);
}

export const minimalBashHarness = Object.freeze<HarnessDefinition<MinimalBashConfig, MinimalBashInput>>({
  identity: MINIMAL_BASH_IDENTITY, migrations: minimalBashMigrations,
  operations: Object.freeze([LLM_OPERATION, PI_BASH_OPERATION]),
  parseConfig: parseMinimalBashConfig, parseInput: parseMinimalBashInput,
  initialize(ctx) {
    ctx.sql.exec("INSERT INTO minimal_bash_state(singleton, phase) VALUES (1, 'idle')").toArray();
    appendMessage(ctx.sql, { role: "system", content: [{ type: "text", text: `${SYSTEM_PROMPT}\nWorking directory: ${ctx.config.cwd}` }] }, null);
  },
  handle(input: Input, ctx) {
    const s = readState(ctx.sql);
    try {
      switch (input.event.type) {
        case "minimal_bash.message":
          ctx.sql.exec("INSERT INTO minimal_bash_pending_messages VALUES (?, ?, ?)", input.eventId, input.sequence, storeMessageJson(ctx.sql, input.event.payload.message)).toArray();
          if (s.phase === "idle") {
            s.run_id = `run_${input.sequence}`; s.turn_count = 0; s.last_error_json = null; s.cancel_requested = 0;
            lifecycle(ctx, s, "run_started", {}, input.eventId); promoteSteering(ctx, s); requestLlm(ctx, s);
          }
          break;
        case "minimal_bash.cancel":
          if (input.event.payload.runId === s.run_id && (s.phase === "llm" || s.phase === "bash") && !s.cancel_requested) {
            s.cancel_requested = 1; lifecycle(ctx, s, "cancel_requested", { mode: "after_turn" }, input.eventId);
          }
          break;
        case "minimal_bash.resume":
          if (s.phase === "cancelled" || s.phase === "failed") {
            const previousRunId = s.run_id;
            s.run_id = `run_${input.sequence}`; s.turn_count = 0; s.last_error_json = null; s.cancel_requested = 0;
            lifecycle(ctx, s, "run_resumed", { previousRunId }, input.eventId); promoteSteering(ctx, s); requestLlm(ctx, s);
          }
          break;
        case "runtime.operation.completed": {
          const { operationId, outcome } = input.event.payload;
          if (operationId !== s.active_operation_id) throw new Error("Completion does not belong to the active harness step.");
          if (s.phase === "llm") completeLlm(ctx, s, outcome, operationId);
          else if (s.phase === "bash") completeBash(ctx, s, outcome, operationId);
          else throw new Error("Completion arrived without an active model turn.");
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof HarnessFailure)) throw error;
      fail(ctx, s, error);
    }
    save(ctx, s);
  },
});
