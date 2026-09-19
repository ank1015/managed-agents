import { ContractException, jsonEquals, parseJsonValue } from "@managed-agents/contracts";
import type { ContractError, CreateSessionRequest, HarnessIdentity, JsonValue, ListSessionsResult, SessionStatus } from "@managed-agents/contracts";
import { ApiError, notFound } from "../http.ts";

export interface DirectoryEntry {
  session_id: string;
  harness_json: string;
  metadata_json: string;
  status: SessionStatus;
  creation_request_id: string;
  creation_request_json: string;
  route_key: string;
  creation_state: "initializing" | "ready" | "failed";
  created_at: number;
  ready_at: number | null;
  error_json: string | null;
}
export class SessionDirectory {
  readonly #db: D1DatabaseSession;
  constructor(db: D1Database) { this.#db = db.withSession("first-primary"); }
  async #creation(requestId: string): Promise<DirectoryEntry | null> {
    return this.#db.prepare("SELECT * FROM sessions WHERE creation_request_id = ?")
      .bind(requestId).first<DirectoryEntry>();
  }
  #checkContent(entry: DirectoryEntry, request: CreateSessionRequest): void {
    if (!jsonEquals(JSON.parse(entry.creation_request_json), parseJsonValue(request))) {
      throw new ApiError(409, "CREATION_CONFLICT", "requestId was already used with different creation content.");
    }
  }
  async reserve(request: CreateSessionRequest, resolveRoute: () => string): Promise<{ entry: DirectoryEntry; duplicate: boolean }> {
    // Recover pinned routes before consulting which harnesses allow new sessions.
    const existing = await this.#creation(request.requestId);
    if (existing) { this.#checkContent(existing, request); return { entry: existing, duplicate: true }; }
    const routeKey = resolveRoute();
    const id = `ses_${crypto.randomUUID()}`;
    const inserted = await this.#db.prepare(`INSERT INTO sessions
      (session_id, harness_json, metadata_json, status, creation_request_id, creation_request_json, route_key, creation_state, created_at)
      VALUES (?, ?, ?, 'idle', ?, ?, ?, 'initializing', ?) ON CONFLICT(creation_request_id) DO NOTHING`)
      .bind(id, JSON.stringify(request.harness), JSON.stringify(request.metadata), request.requestId,
        JSON.stringify(request), routeKey, Date.now()).run();
    const entry = await this.#creation(request.requestId);
    if (!entry) throw new Error("Reserved session disappeared.");
    this.#checkContent(entry, request);
    return { entry, duplicate: inserted.meta.changes === 0 };
  }
  async get(sessionId: string): Promise<DirectoryEntry> {
    const entry = await this.#db.prepare("SELECT * FROM sessions WHERE session_id = ?").bind(sessionId).first<DirectoryEntry>();
    if (!entry) throw notFound();
    return entry;
  }
  async readyEntry(sessionId: string): Promise<DirectoryEntry> {
    const entry = await this.get(sessionId);
    if (entry.creation_state !== "ready") throw new ApiError(409, "SESSION_NOT_READY", "Retry the original session creation request.");
    return entry;
  }
  async list(): Promise<ListSessionsResult> {
    const result = await this.#db.prepare(`SELECT session_id, harness_json, metadata_json, status
      FROM sessions ORDER BY created_at DESC, session_id DESC`).all<{
        session_id: string; harness_json: string; metadata_json: string; status: SessionStatus;
      }>();
    return { sessions: result.results.map(row => ({
      sessionId: row.session_id,
      harness: JSON.parse(row.harness_json) as HarnessIdentity,
      metadata: JSON.parse(row.metadata_json) as { [key: string]: JsonValue },
      status: row.status,
    })) };
  }
  async ready(id: string): Promise<void> {
    await this.#db.prepare("UPDATE sessions SET creation_state = 'ready', ready_at = ? WHERE session_id = ? AND creation_state = 'initializing'").bind(Date.now(), id).run();
  }
  async fail(id: string, error: ContractError): Promise<void> {
    await this.#db.prepare("UPDATE sessions SET creation_state = 'failed', status = 'failed', error_json = ? WHERE session_id = ? AND creation_state = 'initializing'").bind(JSON.stringify(error), id).run();
  }
}
export function throwCreationFailure(entry: DirectoryEntry): void {
  if (entry.creation_state === "failed") {
    const error = JSON.parse(entry.error_json!) as ContractError;
    throw new ContractException(error.code, error.message);
  }
}
