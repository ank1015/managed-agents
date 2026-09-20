import { ContractException, LLM_OPERATION, PI_BASH_OPERATION, MAX_OPERATION_OUTCOME_BYTES, utf8Bytes, parseBashToolInput, parseJsonValue, parseLlmMessage, parseLlmResponse, parseOperationRequest } from "@managed-agents/contracts";
import type { HarnessStatus, InputEnvelope, JsonValue, LlmAssistantMessage, LlmMessage, OperationOutcome, RuntimeEvent } from "@managed-agents/contracts";
import type { HarnessReadContext, HarnessDefinition, PlannedOperation } from "@managed-agents/harness-api";
import { MINIMAL_BASH_IDENTITY, parseMinimalBashConfig, parseMinimalBashInput } from "./contracts.ts";
import type { MinimalBashConfig, MinimalBashInput } from "./contracts.ts";
import { minimalBashSchema } from "./schema.ts";
import { HarnessFailure, buildLlmInput, toolCalls } from "./openai.ts";
import { appendMessage, readState } from "./state.ts";
import type { State } from "./state.ts";

export interface MinimalBashChanges {
  state: State | null;
  messages: { message: LlmMessage; runId: string | null; inContext: boolean; eventId: string | null;
    operationId: string | null; responseMetadata: JsonValue | null }[];
  pending: { eventId: string; sequence: number; message: LlmMessage } | null;
  promotePending: boolean;
}
type Context = HarnessReadContext<MinimalBashConfig> & {
  changes: MinimalBashChanges;
  operations: PlannedOperation[];
  status?: HarnessStatus;
  calls?: ReturnType<typeof toolCalls>;
};
function append(ctx: Context, message: LlmMessage, runId: string | null,
  options: { inContext?: boolean; eventId?: string; operationId?: string; responseMetadata?: JsonValue } = {}): number {
  assertMessageSize(message, options.responseMetadata ?? null, runId, options.eventId ?? null, options.operationId ?? null);
  ctx.changes.messages.push({ message, runId, inContext: options.inContext !== false, eventId: options.eventId ?? null,
    operationId: options.operationId ?? null, responseMetadata: options.responseMetadata ?? null });
  // Local reference to a message not inserted yet; apply resolves it to the SQLite sequence.
  return -ctx.changes.messages.length;
}
function assertMessageSize(...fields: unknown[]): void {
  if (utf8Bytes(JSON.stringify(fields)) > MAX_OPERATION_OUTCOME_BYTES) {
    throw new HarnessFailure("MESSAGE_TOO_LARGE", "Message and metadata exceed the 1,900,000-byte inline storage limit. The oversized message was not stored.");
  }
}
function operation(ctx: Context, key: string, request: Omit<PlannedOperation, "key">): string {
  ctx.operations.push({ key, ...request }); return ctx.operationId(key);
}
type Input = InputEnvelope<MinimalBashInput | RuntimeEvent>;

function save(ctx: Pick<Context, "sql">, s: State): void {
  ctx.sql.exec(`UPDATE minimal_bash_state SET phase = ?, run_id = ?, active_operation_id = ?,
    active_assistant_sequence = ?, next_tool_index = ?, turn_count = ?, cancel_requested = ?, last_error_json = ? WHERE singleton = 1`,
    s.phase, s.run_id, s.active_operation_id, s.active_assistant_sequence, s.next_tool_index, s.turn_count, s.cancel_requested, s.last_error_json).toArray();
}
function fail(ctx: Context, s: State, error: HarnessFailure): void {
  ctx.status = "failed";
  s.phase = "failed"; s.active_operation_id = null; s.active_assistant_sequence = null; s.next_tool_index = 0;
  s.last_error_json = JSON.stringify({ code: error.code, message: error.message }); s.cancel_requested = 0;
}
function promoteSteering(ctx: Context, s: State): number {
  let count = 0;
  for (const row of ctx.sql.exec<{ event_id: string; message_json: string }>(
    "SELECT event_id, message_json FROM minimal_bash_pending_messages ORDER BY input_sequence")) {
    append(ctx, JSON.parse(row.message_json) as LlmMessage, s.run_id, { eventId: row.event_id });
    count++;
  }
  ctx.changes.promotePending ||= count > 0;
  return count;
}
function requestLlm(ctx: Context, s: State): void {
  const input = buildLlmInput(ctx.sql, ctx.config, ctx.session.sessionId, ctx.changes.messages.filter(row => row.inContext).map(row => row.message));
  s.active_operation_id = operation(ctx, "llm", { ...LLM_OPERATION, input });
  s.phase = "llm"; s.turn_count++; s.active_assistant_sequence = null; s.next_tool_index = 0;
}
function finishTurn(ctx: Context, s: State, hadTools: boolean): void {
  s.active_operation_id = null; s.active_assistant_sequence = null; s.next_tool_index = 0;
  if (s.cancel_requested) {
    ctx.status = "cancelled";
    s.phase = "cancelled"; s.cancel_requested = 0;
    return;
  }
  const inserted = promoteSteering(ctx, s);
  if (hadTools || inserted) requestLlm(ctx, s);
  else { s.phase = "idle"; ctx.status = "idle"; }
}
function currentCalls(ctx: Context, s: State) {
  if (ctx.calls) return ctx.calls;
  if (s.active_assistant_sequence === null) throw new Error("Missing active assistant message.");
  const row = ctx.sql.exec<{ message_json: string }>("SELECT message_json FROM minimal_bash_messages WHERE sequence = ?", s.active_assistant_sequence).one();
  return ctx.calls = toolCalls(JSON.parse(row.message_json) as LlmAssistantMessage);
}
function toolResult(ctx: Context, s: State, callId: string, content: JsonValue, error: string | null, details: JsonValue, operationId?: string): void {
  const message = parseLlmMessage({ role: "tool_result", toolName: "bash", toolCallId: callId, content, details,
    outcome: error === null ? { status: "success" } : { status: "error", error: { name: "BashError", message: error } } });
  append(ctx, message, s.run_id, operationId === undefined ? {} : { operationId });
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
    s.active_operation_id = operation(ctx, `bash:${call.callId}`, request);
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
  const row = append(ctx, message, s.run_id, { inContext: false, operationId,
    responseMetadata: parseJsonValue({ ...metadata, gatewayJobId: (outcome.result as { gatewayJobId: string }).gatewayJobId }) });
  if (message.provider !== "openai" || response.modelId !== ctx.config.modelId) throw new HarnessFailure("LLM_MODEL_MISMATCH", "Response does not match the configured provider/model.");
  if (response.stopReason === "length" || response.stopReason === "content_filter" || response.stopReason === "pause_turn") {
    throw new HarnessFailure("LLM_INCOMPLETE", `Model stopped with ${response.stopReason}; no tool calls were executed. The response is retained outside model context.`);
  }
  const calls = toolCalls(message);
  if ((response.stopReason === "tool_use") !== (calls.length > 0)) throw new HarnessFailure("INVALID_LLM_RESPONSE", "Tool calls and stop reason disagree.");
  ctx.changes.messages[-row - 1]!.inContext = true;
  ctx.calls = calls;
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

export const minimalBashHarness = Object.freeze<HarnessDefinition<MinimalBashConfig, MinimalBashInput, MinimalBashChanges>>({
  identity: MINIMAL_BASH_IDENTITY, schema: minimalBashSchema,
  operations: Object.freeze([LLM_OPERATION, PI_BASH_OPERATION]),
  parseConfig: parseMinimalBashConfig, parseInput: parseMinimalBashInput,
  initialize(ctx) {
    ctx.sql.exec("INSERT INTO minimal_bash_state(singleton, phase) VALUES (1, 'idle')").toArray();
  },
  handle(input: Input, read) {
    const ctx: Context = { ...read, changes: { state: null, messages: [], pending: null, promotePending: false }, operations: [] };
    const s = readState(ctx.sql), before = JSON.stringify(s);
    try {
      switch (input.event.type) {
        case "minimal_bash.message":
          if (s.phase === "idle") {
            ctx.status = "running";
            s.run_id = `run_${input.sequence}`; s.turn_count = 0; s.last_error_json = null; s.cancel_requested = 0;
            append(ctx, input.event.payload.message, s.run_id, { eventId: input.eventId }); requestLlm(ctx, s);
          } else {
            assertMessageSize(input.event.payload.message, input.eventId);
            ctx.changes.pending = { eventId: input.eventId, sequence: input.sequence, message: input.event.payload.message };
          }
          break;
        case "minimal_bash.cancel":
          if (input.event.payload.runId === s.run_id && (s.phase === "llm" || s.phase === "bash") && !s.cancel_requested) {
            ctx.status = "cancelling";
            s.cancel_requested = 1;
          }
          break;
        case "minimal_bash.resume":
          if (s.phase === "cancelled" || s.phase === "failed") {
            ctx.status = "running";
            s.run_id = `run_${input.sequence}`; s.turn_count = 0; s.last_error_json = null; s.cancel_requested = 0;
            promoteSteering(ctx, s); requestLlm(ctx, s);
          }
          break;
        case "runtime.operation.completed": {
          const { operationId, outcome } = input.event.payload;
          // Runtime already authenticated/correlated this accepted job. A size failure
          // on steering can stop its run before the job finishes; consume that late result.
          if (operationId !== s.active_operation_id) break;
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
    if (JSON.stringify(s) !== before) ctx.changes.state = s;
    return { changes: ctx.changes, operations: ctx.operations, ...(ctx.status === undefined ? {} : { status: ctx.status }) };
  },
  apply(changes, ctx) {
    const sequences = changes.messages.map(row => appendMessage(ctx.sql, row.message, row.runId, {
      inContext: row.inContext,
      ...(row.eventId === null ? {} : { eventId: row.eventId }),
      ...(row.operationId === null ? {} : { operationId: row.operationId }),
      ...(row.responseMetadata === null ? {} : { responseMetadata: row.responseMetadata }),
    }));
    if (changes.promotePending) ctx.sql.exec("DELETE FROM minimal_bash_pending_messages").toArray();
    if (changes.pending) {
      const p = changes.pending;
      ctx.sql.exec("INSERT INTO minimal_bash_pending_messages VALUES (?, ?, ?)", p.eventId, p.sequence, JSON.stringify(p.message)).toArray();
    }
    if (changes.state) {
      const state = { ...changes.state };
      if (state.active_assistant_sequence !== null && state.active_assistant_sequence < 0) {
        state.active_assistant_sequence = sequences[-state.active_assistant_sequence - 1]!;
      }
      save(ctx, state);
    }
  },
});
