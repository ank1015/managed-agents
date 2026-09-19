import type { SqlStorage } from "@cloudflare/workers-types";
import { nextInput } from "./inbox.ts";

type ProgressRow = {
  failed_event_id: string | null; failures: number; retry_at: number | null;
  blocked: number; last_error: string | null;
};

export interface ProcessingStatus {
  pendingEventId: string | null;
  failures: number;
  retryAt: number | null;
  blocked: boolean;
  lastError: string | null;
}

export function processingStatus(sql: SqlStorage): ProcessingStatus {
  const input = nextInput(sql);
  const row = sql.exec<ProgressRow>("SELECT * FROM runtime_progress WHERE singleton = 1").one();
  const current = input !== undefined && input.eventId === row.failed_event_id;
  return {
    pendingEventId: input?.eventId ?? null,
    failures: current ? row.failures : 0,
    retryAt: current ? row.retry_at : null,
    blocked: current && row.blocked === 1,
    lastError: current ? row.last_error : null,
  };
}

export function resetProcessing(sql: SqlStorage): void {
  sql.exec(`UPDATE runtime_progress SET failed_event_id = NULL, failures = 0, retry_at = NULL,
    blocked = 0, last_error = NULL WHERE singleton = 1`).toArray();
}

export function failProcessing(sql: SqlStorage, status: ProcessingStatus, due: number, maxFailures: number, message: string): void {
  const failures = status.failures + 1;
  sql.exec(`UPDATE runtime_progress SET failed_event_id = ?, failures = ?, retry_at = ?, blocked = ?,
    last_error = ? WHERE singleton = 1`, status.pendingEventId, failures,
  failures >= maxFailures ? null : due, failures >= maxFailures ? 1 : 0, message).toArray();
}
