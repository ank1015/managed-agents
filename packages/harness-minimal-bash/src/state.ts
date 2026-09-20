import type { SqlStorage } from "@cloudflare/workers-types";
import type { JsonValue, LlmMessage } from "@managed-agents/contracts";
import { utf8Bytes } from "@managed-agents/contracts";

export type Sql = Pick<SqlStorage, "exec">;
export type State = {
  singleton: number; phase: "idle" | "llm" | "bash" | "cancelled" | "failed";
  run_id: string | null; active_operation_id: string | null; active_assistant_sequence: number | null;
  next_tool_index: number; turn_count: number; cancel_requested: number; last_error_json: string | null;
};
export function readState(sql: Sql): State { return sql.exec<State>("SELECT * FROM minimal_bash_state WHERE singleton = 1").one(); }
export function readMinimalBashState(sql: Sql) {
  const s = readState(sql);
  return { phase: s.phase, runId: s.run_id, activeOperationId: s.active_operation_id,
    turnCount: s.turn_count, cancelRequested: Boolean(s.cancel_requested),
    error: s.last_error_json === null ? null : JSON.parse(s.last_error_json) as JsonValue,
    pendingMessageCount: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM minimal_bash_pending_messages").one().n };
}
// Bound materialized history even when individual native messages are large.
// A single row always makes progress; the byte budget excludes response-envelope overhead.
const PAGE_JSON_BYTES = 2 * 1024 * 1024;
function pageRows<T>(cursor: Iterable<T>, limit: number, size: (row: T) => number) {
  const rows: T[] = [];
  let bytes = 0;
  for (const row of cursor) {
    const length = size(row);
    if (rows.length >= limit || (rows.length > 0 && bytes + length > PAGE_JSON_BYTES)) return { rows, hasMore: true };
    rows.push(row); bytes += length;
  }
  return { rows, hasMore: false };
}
export function readMinimalBashMessages(sql: Sql, after = 0, limit = 100) {
  const page = pageRows(sql.exec<{ sequence: number; message_json: string; in_context: number; run_id: string | null; response_metadata_json: string | null }>(
    "SELECT sequence, message_json, in_context, run_id, response_metadata_json FROM minimal_bash_messages WHERE sequence > ? ORDER BY sequence LIMIT ?", after, limit + 1),
    limit, row => utf8Bytes(row.message_json) + utf8Bytes(row.response_metadata_json ?? "null"));
  const messages = page.rows.map(row => ({ sequence: row.sequence, message: JSON.parse(row.message_json) as LlmMessage,
    inContext: Boolean(row.in_context), runId: row.run_id,
    responseMetadata: row.response_metadata_json === null ? null : JSON.parse(row.response_metadata_json) as JsonValue }));
  return { messages, nextCursor: page.hasMore ? messages.at(-1)!.sequence : null, state: readMinimalBashState(sql) };
}
export function readPendingMessages(sql: Sql, after = 0, limit = 100) {
  const page = pageRows(sql.exec<{ event_id: string; input_sequence: number; message_json: string }>(
    "SELECT * FROM minimal_bash_pending_messages WHERE input_sequence > ? ORDER BY input_sequence LIMIT ?", after, limit + 1),
    limit, row => utf8Bytes(row.message_json));
  const messages = page.rows.map(row => ({ eventId: row.event_id, inputSequence: row.input_sequence, message: JSON.parse(row.message_json) as LlmMessage }));
  return { messages, nextCursor: page.hasMore ? messages.at(-1)!.inputSequence : null, state: readMinimalBashState(sql) };
}
export function appendMessage(sql: Sql, message: LlmMessage, runId: string | null, options: {
  inContext?: boolean; eventId?: string; operationId?: string; responseMetadata?: JsonValue;
} = {}): number {
  return sql.exec<{ sequence: number }>(`INSERT INTO minimal_bash_messages
    (message_json, in_context, run_id, source_event_id, source_operation_id, response_metadata_json)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING sequence`, JSON.stringify(message), options.inContext === false ? 0 : 1,
    runId, options.eventId ?? null, options.operationId ?? null,
    options.responseMetadata === undefined ? null : JSON.stringify(options.responseMetadata)).one().sequence;
}
