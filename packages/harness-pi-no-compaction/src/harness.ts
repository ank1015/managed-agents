import { ContractException, LLM_OPERATION, MAX_OPERATION_OUTCOME_BYTES, utf8Bytes, parseJsonValue, parseLlmMessage, parseLlmResponse } from "@managed-agents/contracts";
import type { HarnessStatus, InputEnvelope, JsonValue, LlmAssistantMessage, LlmMessage, OperationOutcome, RuntimeEvent } from "@managed-agents/contracts";
import type { HarnessReadContext, HarnessDefinition, PlannedOperation } from "@managed-agents/harness-api";
import { PI_NO_COMPACTION_IDENTITY, parsePiNoCompactionConfig, parsePiNoCompactionInput } from "./contracts.ts";
import type { PiNoCompactionConfig, PiNoCompactionInput } from "./contracts.ts";
import { piNoCompactionSchema } from "./schema.ts";
import { HarnessFailure, buildLlmInput, toolCalls } from "./llm.ts";
import { appendMessage, readState, readBatch } from "./state.ts";
import type { State, BatchRow } from "./state.ts";

import { TOOL_OPERATIONS, toolRequest, isMutation } from "./tools.ts";
import type { ToolCall } from "./tools.ts";

export interface PiNoCompactionChanges {
  batch: BatchRow[];
  clearBatch: boolean;
  state: State | null;
  messages: { message: LlmMessage; runId: string | null; inContext: boolean; eventId: string | null;
    operationId: string | null; responseMetadata: JsonValue | null }[];
  pending: { eventId: string; sequence: number; message: LlmMessage } | null;
  promotePending: boolean;
}
type Context = HarnessReadContext<PiNoCompactionConfig> & {
  changes: PiNoCompactionChanges;
  operations: PlannedOperation[];
  status?: HarnessStatus;
  calls?: ReturnType<typeof toolCalls>;
  batch?: BatchRow[];
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
type Input = InputEnvelope<PiNoCompactionInput | RuntimeEvent>;

function save(ctx: Pick<Context, "sql">, s: State): void {
  ctx.sql.exec(`UPDATE pi_no_compaction_state SET phase = ?, run_id = ?, active_operation_id = ?,
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
    "SELECT event_id, message_json FROM pi_no_compaction_pending_messages ORDER BY input_sequence")) {
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
  const row = ctx.sql.exec<{ message_json: string }>("SELECT message_json FROM pi_no_compaction_messages WHERE sequence = ?", s.active_assistant_sequence).one();
  return ctx.calls = toolCalls(JSON.parse(row.message_json) as LlmAssistantMessage);
}
type ToolMessage = Extract<LlmMessage, { role: "tool_result" }>;
function errorResult(call: ToolCall, text: string, details: JsonValue = {}): ToolMessage {
  text = text.slice(0, 16_384);
  return { role: "tool_result", toolName: call.name, toolCallId: call.callId, content: [{ type: "text", text }], details,
    outcome: { status: "error", error: { name: "ToolError", message: text } } };
}
function batch(ctx: Context): BatchRow[] { return ctx.batch ??= readBatch(ctx.sql); }
function changed(ctx: Context, row: BatchRow): void {
  const i = ctx.changes.batch.findIndex(item => item.call_index === row.call_index);
  if (i < 0) ctx.changes.batch.push(row); else ctx.changes.batch[i] = row;
}
function done(ctx: Context, s: State, row: BatchRow, message: ToolMessage): void {
  assertMessageSize(message, null, s.run_id, null, row.operation_id);
  row.status = "done"; row.result_json = JSON.stringify(message); changed(ctx, row);
}
/** Reads/bash run concurrently. A single ordered mutation lane also covers aliases,
 * case-insensitive paths and hard links: the harness cannot resolve machine file identity.
 * The daemon mutex alone cannot preserve model order across independent gateway jobs. */
function advanceTools(ctx: Context, s: State): void {
  const calls = currentCalls(ctx, s), rows = batch(ctx);
  let mutationBusy = rows.some(row => row.status === "active" && isMutation(calls[row.call_index]!.name));
  for (const row of rows) {
    if (row.status !== "queued") continue;
    const call = calls[row.call_index]!;
    if (s.last_error_json !== null) {
      done(ctx, s, row, errorResult(call, "Not executed: a tool operation could not be safely completed.", { executed: false }));
      continue;
    }
    if (isMutation(call.name) && mutationBusy) continue;
    let request;
    try { request = toolRequest(call, ctx.config); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof ContractException)) throw error;
      done(ctx, s, row, errorResult(call, `Invalid ${call.name} arguments: ${error.message}`, { executed: false }));
      continue;
    }
    row.operation_id = operation(ctx, `tool:${row.call_index}`, request);
    row.status = "active"; changed(ctx, row);
    if (isMutation(call.name)) mutationBusy = true;
  }
  // Flush only a contiguous prefix; arrival order must never change replay order.
  while (s.next_tool_index < rows.length) {
    const row = rows[s.next_tool_index]!;
    if (row.status !== "done") break;
    if (row.result_json === null) throw new Error("Missing unflushed tool result.");
    append(ctx, JSON.parse(row.result_json) as ToolMessage, s.run_id,
      row.operation_id === null ? {} : { operationId: row.operation_id });
    row.result_json = null; changed(ctx, row); s.next_tool_index++;
  }
  if (s.next_tool_index !== rows.length) return;
  ctx.changes.clearBatch = true; ctx.changes.batch = [];
  if (s.last_error_json !== null) {
    const error = JSON.parse(s.last_error_json) as { code: string; message: string };
    fail(ctx, s, new HarnessFailure(error.code, error.message));
  } else finishTurn(ctx, s, true);
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
  if (message.provider !== ctx.config.provider || response.modelId !== ctx.config.modelId) throw new HarnessFailure("LLM_MODEL_MISMATCH", "Response does not match the configured provider/model.");
  if (response.stopReason === "length" || response.stopReason === "content_filter" || response.stopReason === "pause_turn") {
    throw new HarnessFailure("LLM_INCOMPLETE", `Model stopped with ${response.stopReason}; no tool calls were executed. The response is retained outside model context.`);
  }
  const calls = toolCalls(message);
  if ((response.stopReason === "tool_use") !== (calls.length > 0)) throw new HarnessFailure("INVALID_LLM_RESPONSE", "Tool calls and stop reason disagree.");
  ctx.changes.messages[-row - 1]!.inContext = true;
  ctx.calls = calls;
  s.active_operation_id = null;
  if (calls.length) {
    s.phase = "tools"; s.active_assistant_sequence = row; s.next_tool_index = 0;
    ctx.batch = calls.map((_, call_index) => ({ call_index, status: "queued", operation_id: null, result_json: null }));
    ctx.changes.batch = [...ctx.batch];
    advanceTools(ctx, s);
  }
  else finishTurn(ctx, s, false);
}
function completeTool(ctx: Context, s: State, outcome: OperationOutcome, operationId: string): void {
  const row = batch(ctx).find(row => row.operation_id === operationId && row.status === "active");
  if (!row) return;
  const call = currentCalls(ctx, s)[row.call_index]!;
  let message: ToolMessage, failure: HarnessFailure | undefined;
  if (outcome.status === "succeeded") {
    try {
      const result = outcome.result;
      if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.isError !== "boolean"
        || !Array.isArray(result.content) || result.content.length === 0
        || !result.details || typeof result.details !== "object" || Array.isArray(result.details)) throw new Error("Malformed tool result.");
      if (call.name !== "read" && result.content.some(part => !part || typeof part !== "object" || Array.isArray(part) || part.type !== "text")) throw new Error("Unexpected non-text tool result.");
      message = parseLlmMessage({ role: "tool_result", toolName: call.name, toolCallId: call.callId, content: result.content, details: result.details,
        outcome: result.isError ? { status: "error", error: { name: "ToolError", message: `${call.name} failed; see tool output.` } } : { status: "success" } }) as ToolMessage;
      assertMessageSize(message, null, s.run_id, null, row.operation_id);
      if (call.name === "bash" && result.details.reason === "lost") failure = new HarnessFailure("BASH_EXECUTION_UNKNOWN", "Execution outcome is unknown. Inspect the machine before resuming.");
    } catch (error) {
      // A malformed/oversized completion may describe an already executed mutation.
      failure = new HarnessFailure("INVALID_TOOL_RESULT", "Tool result could not be retained or validated. Execution may have occurred; inspect the machine before resuming.");
      message = errorResult(call, failure.message, { outcomeUnknown: true });
    }
  } else {
    failure = new HarnessFailure(outcome.status === "failed" ? outcome.error.code : "TOOL_CANCELLED",
      outcome.status === "failed" ? outcome.error.message.slice(0, 16_384) : "Tool operation was cancelled upstream.");
    message = errorResult(call, failure.message, { outcomeUnknown: true });
  }
  done(ctx, s, row, message);
  // Already submitted siblings must settle before failure/resume. Never orphan effects.
  if (failure && s.last_error_json === null) s.last_error_json = JSON.stringify({ code: failure.code.slice(0, 1024), message: failure.message });
  advanceTools(ctx, s);
}

export const piNoCompactionHarness = Object.freeze<HarnessDefinition<PiNoCompactionConfig, PiNoCompactionInput, PiNoCompactionChanges>>({
  identity: PI_NO_COMPACTION_IDENTITY, schema: piNoCompactionSchema,
  operations: Object.freeze([LLM_OPERATION, ...TOOL_OPERATIONS]),
  parseConfig: parsePiNoCompactionConfig, parseInput: parsePiNoCompactionInput,
  initialize(ctx) {
    ctx.sql.exec("INSERT INTO pi_no_compaction_state(singleton, phase) VALUES (1, 'idle')").toArray();
  },
  handle(input: Input, read) {
    const ctx: Context = { ...read, changes: { state: null, messages: [], pending: null, promotePending: false, batch: [], clearBatch: false }, operations: [] };
    const s = readState(ctx.sql), before = JSON.stringify(s);
    try {
      switch (input.event.type) {
        case "pi_no_compaction.message":
          if (s.phase === "idle") {
            ctx.status = "running";
            s.run_id = `run_${input.sequence}`; s.turn_count = 0; s.last_error_json = null; s.cancel_requested = 0;
            append(ctx, input.event.payload.message, s.run_id, { eventId: input.eventId }); requestLlm(ctx, s);
          } else {
            assertMessageSize(input.event.payload.message, input.eventId);
            ctx.changes.pending = { eventId: input.eventId, sequence: input.sequence, message: input.event.payload.message };
          }
          break;
        case "pi_no_compaction.cancel":
          if (input.event.payload.runId === s.run_id && (s.phase === "llm" || s.phase === "tools") && !s.cancel_requested) {
            ctx.status = "cancelling";
            s.cancel_requested = 1;
          }
          break;
        case "pi_no_compaction.resume":
          if (s.phase === "cancelled" || s.phase === "failed") {
            ctx.status = "running";
            s.run_id = `run_${input.sequence}`; s.turn_count = 0; s.last_error_json = null; s.cancel_requested = 0;
            promoteSteering(ctx, s); requestLlm(ctx, s);
          }
          break;
        case "runtime.operation.completed": {
          const { operationId, outcome } = input.event.payload;
          if (s.phase === "tools") completeTool(ctx, s, outcome, operationId);
          else if (s.phase === "llm" && operationId === s.active_operation_id) completeLlm(ctx, s, outcome, operationId);
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
    if (changes.clearBatch) ctx.sql.exec("DELETE FROM pi_no_compaction_batch").toArray();
    else for (const row of changes.batch) ctx.sql.exec(`INSERT INTO pi_no_compaction_batch VALUES (?, ?, ?, ?)
      ON CONFLICT(call_index) DO UPDATE SET status = excluded.status, operation_id = excluded.operation_id, result_json = excluded.result_json`,
      row.call_index, row.status, row.operation_id, row.result_json).toArray();
    const sequences = changes.messages.map(row => appendMessage(ctx.sql, row.message, row.runId, {
      inContext: row.inContext,
      ...(row.eventId === null ? {} : { eventId: row.eventId }),
      ...(row.operationId === null ? {} : { operationId: row.operationId }),
      ...(row.responseMetadata === null ? {} : { responseMetadata: row.responseMetadata }),
    }));
    if (changes.promotePending) ctx.sql.exec("DELETE FROM pi_no_compaction_pending_messages").toArray();
    if (changes.pending) {
      const p = changes.pending;
      ctx.sql.exec("INSERT INTO pi_no_compaction_pending_messages VALUES (?, ?, ?)", p.eventId, p.sequence, JSON.stringify(p.message)).toArray();
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
