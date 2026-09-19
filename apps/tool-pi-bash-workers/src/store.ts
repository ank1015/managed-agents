import type { BashInput, BashSubmission, OperationFailure, ExecutionGatewayEvent } from "@managed-agents/contracts";
import type { Work } from "./types.ts";

export interface OperationRow {
  submission_id: string; operation_id: string; route_key: string; session_id: string; request_hash: string;
  machine_id: string; timeout_seconds: number | null;
  gateway_key: string; gateway_job_id: string | null; state: "submitting" | "accepted" | "terminal" | "rejected";
  rejection_json: string | null; delivered_at: number | null; attempts: number; lease_token: string | null;
}
const LEASE_MS = 60_000;
export class Store {
  constructor(readonly db: D1Database) {}
  operation(id: string) { return this.db.prepare("SELECT * FROM bash_operations WHERE submission_id = ?").bind(id).first<OperationRow>(); }
  async reserve(value: BashSubmission, input: BashInput, hash: string, key: string): Promise<OperationRow> {
    const { destination: d, submission: s } = value, now = Date.now();
    await this.db.prepare(`INSERT INTO bash_operations
      (submission_id, operation_id, route_key, session_id, machine_id, timeout_seconds, request_hash, gateway_key, state, created_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?) ON CONFLICT(submission_id) DO NOTHING`)
      .bind(s.submissionId, s.operationId, d.routeKey, d.sessionId, input.machineId, input.timeout ?? null, hash, key, now, now + 60_000).run();
    const row = (await this.operation(s.submissionId))!;
    if (row.operation_id !== s.operationId || row.route_key !== d.routeKey || row.session_id !== d.sessionId || row.request_hash !== hash || row.gateway_key !== key
      || row.machine_id !== input.machineId || row.timeout_seconds !== (input.timeout ?? null)) {
      throw new Error("Submission identity conflicts with retained input or destination.");
    }
    return row;
  }
  async bindJob(id: string, jobId: string): Promise<OperationRow> {
    const row = await this.db.prepare(`UPDATE bash_operations SET gateway_job_id = ?,
      state = CASE WHEN state = 'submitting' THEN 'accepted' ELSE state END,
      next_attempt_at = MIN(next_attempt_at, ?) WHERE submission_id = ? AND state != 'rejected'
      AND (gateway_job_id IS NULL OR gateway_job_id = ?) RETURNING *`)
      .bind(jobId, Date.now(), id, jobId).first<OperationRow>();
    if (!row) throw new Error("Gateway job conflicts with retained operation.");
    return row;
  }
  async reject(id: string, error: OperationFailure): Promise<void> {
    await this.db.prepare(`UPDATE bash_operations SET state = 'rejected', rejection_json = ?, lease_token = NULL, lease_until = NULL
      WHERE submission_id = ? AND state = 'submitting' AND gateway_job_id IS NULL`).bind(JSON.stringify(error), id).run();
  }
  async admitEvent(event: ExecutionGatewayEvent): Promise<OperationRow> {
    // Bind the job and schedule processing in the same write. Do not steal an active delivery lease.
    const row = await this.db.prepare(`UPDATE bash_operations SET gateway_job_id = ?, state = 'terminal',
      next_attempt_at = MIN(next_attempt_at, ?) WHERE submission_id = ? AND machine_id = ? AND state != 'rejected'
      AND (gateway_job_id IS NULL OR gateway_job_id = ?) RETURNING *`)
      .bind(event.jobId, Date.now(), event.clientContext.reference, event.machineId, event.jobId).first<OperationRow>();
    if (!row) throw new Error("Gateway event conflicts with or has no matching operation reservation.");
    return row;
  }
  async claim(work: Work): Promise<OperationRow | null> {
    const now = Date.now();
    return this.db.prepare(`UPDATE bash_operations SET lease_token = ?, lease_until = ?, attempts = attempts + 1
      WHERE submission_id = ? AND delivered_at IS NULL AND state != 'rejected' AND next_attempt_at <= ?
      AND (lease_until IS NULL OR lease_until <= ?) RETURNING *`)
      .bind(crypto.randomUUID(), now + LEASE_MS, work.id, now, now).first<OperationRow>();
  }
  async retry(work: Work, token: string, attempt: number, message: string | null, pending = false): Promise<number> {
    const delay = pending ? 60_000 : Math.round(Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9)) * (0.5 + Math.random() / 2));
    const now = Date.now();
    const due = pending ? "CASE WHEN state = 'terminal' THEN MIN(next_attempt_at, ?) ELSE ? END" : "?";
    const bindings = pending ? [now + 1000, now + delay] : [now + delay];
    const row = await this.db.prepare(`UPDATE bash_operations SET lease_token = NULL, lease_until = NULL, next_attempt_at = ${due}, last_error = ?
      WHERE submission_id = ? AND lease_token = ? RETURNING next_attempt_at`)
      .bind(...bindings, message?.slice(0, 1000) ?? null, work.id, token).first<{ next_attempt_at: number }>();
    return Math.max(1, Math.ceil(((row?.next_attempt_at ?? now + delay) - now) / 1000));
  }
  async terminal(id: string) {
    await this.db.prepare("UPDATE bash_operations SET state = 'terminal', next_attempt_at = MIN(next_attempt_at, ?) WHERE submission_id = ? AND state != 'rejected'")
      .bind(Date.now(), id).run();
  }
  async delivered(id: string, token: string) {
    await this.db.prepare(`UPDATE bash_operations SET delivered_at = COALESCE(delivered_at, ?), lease_token = NULL,
      lease_until = NULL, last_error = NULL WHERE submission_id = ? AND lease_token = ?`).bind(Date.now(), id, token).run();
  }
  async due(): Promise<Work[]> {
    const now = Date.now();
    const rows = await this.db.prepare(`SELECT 'operation' AS kind, submission_id AS id, next_attempt_at FROM bash_operations
      WHERE delivered_at IS NULL AND state != 'rejected' AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_attempt_at, id LIMIT 100`).bind(now, now).all<Work>();
    return rows.results;
  }
}
