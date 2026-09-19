import type { SqlStorage } from "@cloudflare/workers-types";
import type { EventBody, InputEnvelope } from "@managed-agents/contracts";
import { readJson, writeJson } from "@managed-agents/sqlite-json";

type InboxRow = { event_id: string; sequence: number; received_at: number; event_json: string };
function envelope(sql: SqlStorage, row: InboxRow): InputEnvelope {
  return { eventId: row.event_id, sequence: row.sequence, receivedAt: row.received_at, event: readJson<EventBody>(sql, "runtime_json_chunks", row.event_json) };
}

export function findInput(sql: SqlStorage, eventId: string): InputEnvelope | undefined {
  const row = sql.exec<InboxRow>("SELECT event_id, sequence, received_at, event_json FROM runtime_inbox WHERE event_id = ?", eventId).toArray()[0];
  return row && envelope(sql, row);
}

export function nextInput(sql: SqlStorage): InputEnvelope | undefined {
  const row = sql.exec<InboxRow>(`SELECT event_id, sequence, received_at, event_json FROM runtime_inbox
    WHERE consumed_at IS NULL ORDER BY sequence LIMIT 1`).toArray()[0];
  return row && envelope(sql, row);
}

export function insertInput(sql: SqlStorage, input: InputEnvelope): void {
  sql.exec("INSERT INTO runtime_inbox (event_id, sequence, received_at, event_json) VALUES (?, ?, ?, ?)",
    input.eventId, input.sequence, input.receivedAt, writeJson(sql, "runtime_json_chunks", input.event)).toArray();
}

export function consumeInput(sql: SqlStorage, eventId: string, consumedAt: number): void {
  sql.exec("UPDATE runtime_inbox SET consumed_at = ? WHERE event_id = ? AND consumed_at IS NULL", consumedAt, eventId).toArray();
}
