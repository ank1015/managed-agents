import type { SqlStorage } from "@cloudflare/workers-types";
export interface PendingOperation {
  operationId: string; sourceInputSequence: number; key: string; provider: string; jobId: string;
}
type Row = { operation_id: string; source_input_sequence: number; operation_key: string; provider: string; job_id: string };
const info = (r: Row): PendingOperation => ({ operationId: r.operation_id, sourceInputSequence: r.source_input_sequence,
  key: r.operation_key, provider: r.provider, jobId: r.job_id });
/** Accepted-job correlation only. No requests, results, delivery leases, or historical ledger. */
export class PendingOperations {
  readonly sql: SqlStorage;
  constructor(sql: SqlStorage) { this.sql = sql; }
  find(id: string): PendingOperation | undefined {
    const row = this.sql.exec<Row>("SELECT * FROM runtime_pending_operations WHERE operation_id = ?", id).toArray()[0];
    return row && info(row);
  }
  list(): PendingOperation[] { return this.sql.exec<Row>("SELECT * FROM runtime_pending_operations ORDER BY source_input_sequence, operation_key").toArray().map(info); }
  insert(id: string, sequence: number, key: string, provider: string, jobId: string): void {
    this.sql.exec("INSERT INTO runtime_pending_operations VALUES (?, ?, ?, ?, ?)", id, sequence, key, provider, jobId).toArray();
  }
  delete(id: string): void { this.sql.exec("DELETE FROM runtime_pending_operations WHERE operation_id = ?", id).toArray(); }
}
