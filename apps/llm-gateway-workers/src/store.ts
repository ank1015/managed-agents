import type { LlmSubmission, OperationFailure } from "@managed-agents/contracts";
import type { Work } from "./types.ts";

export interface OperationRow {
  submission_id: string; operation_id: string; route_key: string; session_id: string; request_hash: string;
  gateway_key: string; gateway_job_id: string | null; state: "submitting" | "accepted" | "terminal" | "rejected";
  rejection_json: string | null; delivered_at: number | null; attempts: number; lease_token: string | null;
}
export interface WebhookEvent { eventId: string; jobId: string; type: "job.succeeded" | "job.failed" | "job.cancelled"; completedAt: string }
export interface EventRow {
  event_id: string; job_id: string; type: WebhookEvent["type"]; completed_at: string; processed_at: number | null;
  attempts: number; lease_token: string | null;
}
const LEASE_MS = 60_000;
export class Store {
  constructor(readonly db: D1Database) {}
  operation(id: string) { return this.db.prepare("SELECT * FROM llm_operations WHERE submission_id = ?").bind(id).first<OperationRow>(); }
  byJob(id: string) { return this.db.prepare("SELECT * FROM llm_operations WHERE gateway_job_id = ?").bind(id).first<OperationRow>(); }
  byKey(key: string) { return this.db.prepare("SELECT * FROM llm_operations WHERE gateway_key = ?").bind(key).first<OperationRow>(); }
  async reserve(value: LlmSubmission, hash: string, key: string): Promise<OperationRow> {
    const { destination: d, submission: s } = value, now = Date.now();
    await this.db.prepare(`INSERT INTO llm_operations
      (submission_id, operation_id, route_key, session_id, request_hash, gateway_key, state, created_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, 'submitting', ?, ?) ON CONFLICT(submission_id) DO NOTHING`)
      .bind(s.submissionId, s.operationId, d.routeKey, d.sessionId, hash, key, now, now + 60_000).run();
    const row = (await this.operation(s.submissionId))!;
    if (row.operation_id !== s.operationId || row.route_key !== d.routeKey || row.session_id !== d.sessionId || row.request_hash !== hash || row.gateway_key !== key) {
      throw new Error("Submission identity conflicts with retained input or destination.");
    }
    return row;
  }
  async bindJob(id: string, jobId: string): Promise<OperationRow> {
    const row = await this.db.prepare(`UPDATE llm_operations SET gateway_job_id = ?,
      state = CASE WHEN state = 'submitting' THEN 'accepted' ELSE state END,
      next_attempt_at = MIN(next_attempt_at, ?) WHERE submission_id = ? AND state != 'rejected'
      AND (gateway_job_id IS NULL OR gateway_job_id = ?) RETURNING *`)
      .bind(jobId, Date.now(), id, jobId).first<OperationRow>();
    if (!row) throw new Error("Gateway job conflicts with retained operation.");
    return row;
  }
  async reject(id: string, error: OperationFailure): Promise<void> {
    await this.db.prepare(`UPDATE llm_operations SET state = 'rejected', rejection_json = ?, lease_token = NULL, lease_until = NULL
      WHERE submission_id = ? AND state = 'submitting' AND gateway_job_id IS NULL`).bind(JSON.stringify(error), id).run();
  }
  async event(value: WebhookEvent): Promise<void> {
    const now = Date.now();
    await this.db.prepare(`INSERT INTO llm_webhook_events (event_id, job_id, type, completed_at, received_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
      .bind(value.eventId, value.jobId, value.type, value.completedAt, now, now).run();
    const row = await this.db.prepare("SELECT * FROM llm_webhook_events WHERE event_id = ?").bind(value.eventId).first<EventRow>();
    if (row!.job_id !== value.jobId || row!.type !== value.type || row!.completed_at !== value.completedAt) throw new Error("Webhook event identity conflict.");
  }
  async claim(work: Work): Promise<OperationRow | EventRow | null> {
    const { table, key, pending } = target(work), now = Date.now();
    return this.db.prepare(`UPDATE ${table} SET lease_token = ?, lease_until = ?, attempts = attempts + 1
      WHERE ${key} = ? AND ${pending} AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?) RETURNING *`)
      .bind(crypto.randomUUID(), now + LEASE_MS, work.id, now, now).first<OperationRow | EventRow>();
  }
  async retry(work: Work, token: string, attempt: number, message: string | null, pending = false): Promise<number> {
    const { table, key } = target(work);
    const delay = pending ? 60_000 : Math.round(Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9)) * (0.5 + Math.random() / 2));
    const now = Date.now();
    const due = work.kind === "operation" && pending ? "CASE WHEN state = 'terminal' THEN MIN(next_attempt_at, ?) ELSE ? END" : "?";
    const bindings = work.kind === "operation" && pending ? [now + 1000, now + delay] : [now + delay];
    const row = await this.db.prepare(`UPDATE ${table} SET lease_token = NULL, lease_until = NULL, next_attempt_at = ${due}, last_error = ?
      WHERE ${key} = ? AND lease_token = ? RETURNING next_attempt_at`)
      .bind(...bindings, message?.slice(0, 1000) ?? null, work.id, token).first<{ next_attempt_at: number }>();
    return Math.max(1, Math.ceil(((row?.next_attempt_at ?? now + delay) - now) / 1000));
  }
  async terminal(id: string) {
    await this.db.prepare("UPDATE llm_operations SET state = 'terminal', next_attempt_at = MIN(next_attempt_at, ?) WHERE submission_id = ? AND state != 'rejected'")
      .bind(Date.now(), id).run();
  }
  async delivered(id: string, token: string) {
    await this.db.prepare(`UPDATE llm_operations SET delivered_at = COALESCE(delivered_at, ?), lease_token = NULL,
      lease_until = NULL, last_error = NULL WHERE submission_id = ? AND lease_token = ?`).bind(Date.now(), id, token).run();
  }
  async processed(id: string, token: string) {
    await this.db.prepare(`UPDATE llm_webhook_events SET processed_at = ?, lease_token = NULL, lease_until = NULL,
      last_error = NULL WHERE event_id = ? AND lease_token = ?`).bind(Date.now(), id, token).run();
  }
  async due(): Promise<Work[]> {
    const now = Date.now();
    const rows = await this.db.prepare(`SELECT 'operation' AS kind, submission_id AS id, next_attempt_at FROM llm_operations
      WHERE delivered_at IS NULL AND state != 'rejected' AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      UNION ALL SELECT 'event' AS kind, event_id AS id, next_attempt_at FROM llm_webhook_events
      WHERE processed_at IS NULL AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_attempt_at, id LIMIT 100`).bind(now, now, now, now).all<Work>();
    return rows.results;
  }
}
function target(work: Work) {
  return work.kind === "operation"
    ? { table: "llm_operations", key: "submission_id", pending: "delivered_at IS NULL AND state != 'rejected'" }
    : { table: "llm_webhook_events", key: "event_id", pending: "processed_at IS NULL" };
}
