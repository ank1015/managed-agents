import type { ExecutionGatewayEvent } from "@managed-agents/contracts";

export interface EventRow {
  event_id: string; job_id: string; machine_id: string; receiver: string; reference: string;
  type: ExecutionGatewayEvent["type"]; completed_at: string; delivered_at: number | null;
  attempts: number; lease_token: string | null;
}
export class Store {
  constructor(readonly db: D1Database) {}
  event(id: string) { return this.db.prepare("SELECT * FROM gateway_callback_events WHERE event_id = ?").bind(id).first<EventRow>(); }
  async admit(event: ExecutionGatewayEvent): Promise<void> {
    const now = Date.now();
    await this.db.prepare(`INSERT INTO gateway_callback_events
      (event_id, job_id, machine_id, receiver, reference, type, completed_at, received_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
      .bind(event.eventId, event.jobId, event.machineId, event.clientContext.receiver, event.clientContext.reference,
        event.type, event.completedAt, now, now).run();
    const row = (await this.event(event.eventId))!;
    if (row.job_id !== event.jobId || row.machine_id !== event.machineId || row.receiver !== event.clientContext.receiver
      || row.reference !== event.clientContext.reference || row.type !== event.type || row.completed_at !== event.completedAt) {
      throw new Error("Callback event identity conflict.");
    }
  }
  claim(id: string): Promise<EventRow | null> {
    const now = Date.now();
    return this.db.prepare(`UPDATE gateway_callback_events SET lease_token = ?, lease_until = ?, attempts = attempts + 1
      WHERE event_id = ? AND delivered_at IS NULL AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?) RETURNING *`)
      .bind(crypto.randomUUID(), now + 60_000, id, now, now).first<EventRow>();
  }
  async delivered(id: string, token: string): Promise<void> {
    await this.db.prepare(`UPDATE gateway_callback_events SET delivered_at = COALESCE(delivered_at, ?),
      lease_token = NULL, lease_until = NULL, last_error = NULL WHERE event_id = ? AND lease_token = ?`)
      .bind(Date.now(), id, token).run();
  }
  async retry(row: EventRow, message: string): Promise<number> {
    const delay = Math.round(Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 9)) * (0.5 + Math.random() / 2));
    await this.db.prepare(`UPDATE gateway_callback_events SET next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
      last_error = ? WHERE event_id = ? AND lease_token = ?`)
      .bind(Date.now() + delay, message.slice(0, 1000), row.event_id, row.lease_token).run();
    return Math.max(1, Math.ceil(delay / 1000));
  }
  async due(): Promise<{ eventId: string }[]> {
    const now = Date.now();
    const rows = await this.db.prepare(`SELECT event_id AS eventId FROM gateway_callback_events WHERE delivered_at IS NULL
      AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY next_attempt_at, event_id LIMIT 100`).bind(now, now).all<{ eventId: string }>();
    return rows.results;
  }
}
export function toEvent(row: EventRow): ExecutionGatewayEvent {
  return { schemaVersion: 2, eventId: row.event_id, jobId: row.job_id, machineId: row.machine_id,
    type: row.type, completedAt: row.completed_at, clientContext: { receiver: row.receiver, reference: row.reference } };
}
