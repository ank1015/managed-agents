import type { SqlStorage } from "@cloudflare/workers-types";
import type { EventBody, InputEnvelope } from "@managed-agents/contracts";
import { ContractException, MAX_INLINE_ROW_BYTES, utf8Bytes } from "@managed-agents/contracts";
import { inputHash } from "../input-hash.ts";

type InboxRow = { event_id: string; sequence: number; received_at: number; event_json: string };
export type InputRecord = Pick<InputEnvelope, "eventId" | "sequence" | "receivedAt"> & { hash: string; consumed: boolean };
export type PendingInput = InputEnvelope;
function envelope(row: InboxRow): PendingInput {
  return { eventId: row.event_id, sequence: row.sequence, receivedAt: row.received_at,
    event: JSON.parse(row.event_json) as EventBody };
}

export function findInput(sql: SqlStorage, eventId: string): InputRecord | undefined {
  const row = sql.exec<{ event_id: string; sequence: number; received_at: number; event_hash: string; consumed_at: number | null }>(
    "SELECT event_id, sequence, received_at, event_hash, consumed_at FROM runtime_inbox WHERE event_id = ?", eventId).toArray()[0];
  return row && { eventId: row.event_id, sequence: row.sequence, receivedAt: row.received_at, hash: row.event_hash, consumed: row.consumed_at !== null };
}

export function nextInput(sql: SqlStorage): PendingInput | undefined {
  const row = sql.exec<InboxRow>(`SELECT event_id, sequence, received_at, event_json FROM runtime_inbox
    WHERE consumed_at IS NULL ORDER BY sequence LIMIT 1`).toArray()[0];
  return row && envelope(row);
}

/** Caller owns the insertion transaction. Consumed rows retain the sequence high-water mark. */
export function allocateSequence(sql: SqlStorage): number {
  const sequence = sql.exec<{ sequence: number }>(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM runtime_inbox").one().sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("input sequence exhausted or invalid.");
  return sequence;
}

export function insertInput(sql: SqlStorage, input: InputEnvelope, hash = inputHash(input.event)): void {
  const json = JSON.stringify(input.event);
  if (utf8Bytes(json) + utf8Bytes(input.eventId) + hash.length > MAX_INLINE_ROW_BYTES) {
    throw new ContractException("INVALID_INPUT", "Input exceeds the inline SQLite row limit.");
  }
  sql.exec("INSERT INTO runtime_inbox (event_id, sequence, received_at, event_hash, event_json) VALUES (?, ?, ?, ?, ?)",
    input.eventId, input.sequence, input.receivedAt, hash, json).toArray();
}

/** Caller owns the handler transaction: payload cleanup rolls back with its effects. */
export function consumeInput(sql: SqlStorage, input: PendingInput, consumedAt: number): void {
  sql.exec(`UPDATE runtime_inbox SET consumed_at = ?, event_json = NULL, retry_at = NULL,
    retry_count = 0, last_error = NULL, blocked = 0 WHERE event_id = ? AND consumed_at IS NULL`,
    consumedAt, input.eventId).toArray();
}
