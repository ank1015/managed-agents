import type { SqlStorage } from "@cloudflare/workers-types";

export interface ProcessingStatus {
  pendingEventId: string | null; failures: number; retryAt: number | null; blocked: boolean; lastError: string | null;
}
export function processingStatus(sql: SqlStorage): ProcessingStatus {
  const row = sql.exec<{ event_id: string; retry_count: number; retry_at: number | null; blocked: number; last_error: string | null }>(
    `SELECT event_id, retry_count, retry_at, blocked, last_error FROM runtime_inbox
      WHERE consumed_at IS NULL ORDER BY sequence LIMIT 1`).toArray()[0];
  return row ? { pendingEventId: row.event_id, failures: row.retry_count, retryAt: row.retry_at,
    blocked: row.blocked === 1, lastError: row.last_error }
    : { pendingEventId: null, failures: 0, retryAt: null, blocked: false, lastError: null };
}
export function resetProcessing(sql: SqlStorage): void {
  sql.exec(`UPDATE runtime_inbox SET retry_at = NULL, retry_count = 0, blocked = 0, last_error = NULL
    WHERE event_id = (SELECT event_id FROM runtime_inbox WHERE consumed_at IS NULL ORDER BY sequence LIMIT 1)
      AND (retry_count != 0 OR blocked != 0)`).toArray();
}
export function failProcessing(sql: SqlStorage, status: ProcessingStatus, due: number, blocked: boolean, message: string): void {
  sql.exec(`UPDATE runtime_inbox SET retry_count = retry_count + 1, retry_at = ?, blocked = ?, last_error = ?
    WHERE event_id = ? AND consumed_at IS NULL`, blocked ? null : due, blocked ? 1 : 0, message, status.pendingEventId).toArray();
}
