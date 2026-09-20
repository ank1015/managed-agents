import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types";
import { ContractException, parseJsonValue } from "@managed-agents/contracts";
import type { ContractError, CreateSessionRequest, HarnessIdentity, JsonValue, ListSessionsResult, SessionStatus } from "@managed-agents/contracts";
import { ApiError, notFound } from "../http.ts";
import { creationHash } from "./hash.ts";

export interface DirectoryEntry {
  session_id: string;
  harness_json: string;
  metadata_json: string;
  status: SessionStatus;
  creation_request_id: string;
  creation_request_hash: string;
  route_key: string;
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
  #checkContent(entry: DirectoryEntry, hash: string): void {
    if (entry.creation_request_hash !== hash) {
      throw new ApiError(409, "CREATION_CONFLICT", "requestId was already used with different creation content.");
    }
  }
  async reserve(request: CreateSessionRequest, resolveRoute: () => string): Promise<{ entry: DirectoryEntry; duplicate: boolean }> {
    const hash = await creationHash(parseJsonValue(request));
    // Recover pinned routes before consulting which harnesses allow new sessions.
    const existing = await this.#creation(request.requestId);
    if (existing) { this.#checkContent(existing, hash); return { entry: existing, duplicate: true }; }
    const routeKey = resolveRoute();
    const id = `ses_${crypto.randomUUID()}`;
    const inserted = await this.#db.prepare(`INSERT INTO sessions
      (session_id, harness_json, metadata_json, status, creation_request_id, creation_request_hash, route_key, created_at)
      VALUES (?, ?, ?, 'initializing', ?, ?, ?, ?) ON CONFLICT(creation_request_id) DO NOTHING RETURNING *`)
      .bind(id, JSON.stringify(request.harness), JSON.stringify(request.metadata), request.requestId,
        hash, routeKey, Date.now()).first<DirectoryEntry>();
    const entry = inserted ?? await this.#creation(request.requestId);
    if (!entry) throw new Error("Reserved session disappeared.");
    this.#checkContent(entry, hash);
    return { entry, duplicate: inserted === null };
  }
  async get(sessionId: string): Promise<DirectoryEntry> {
    const entry = await this.#db.prepare("SELECT * FROM sessions WHERE session_id = ?").bind(sessionId).first<DirectoryEntry>();
    if (!entry) throw notFound();
    return entry;
  }
  async readyEntry(sessionId: string): Promise<Pick<DirectoryEntry, "route_key" | "status">> {
    const entry = await this.#db.prepare("SELECT route_key, status FROM sessions WHERE session_id = ?")
      .bind(sessionId).first<Pick<DirectoryEntry, "route_key" | "status">>();
    if (!entry) throw notFound();
    if (["initializing", "initialization_failed", "destroyed"].includes(entry.status)) throw new ApiError(409, "SESSION_NOT_READY", "Session is not initialized or has been retired.");
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
    await this.#db.prepare("UPDATE sessions SET status = 'idle', ready_at = ? WHERE session_id = ? AND status = 'initializing'").bind(Date.now(), id).run();
  }
  async fail(id: string, error: ContractError): Promise<void> {
    await this.#db.prepare("UPDATE sessions SET status = 'initialization_failed', error_json = ? WHERE session_id = ? AND status = 'initializing'").bind(JSON.stringify(error), id).run();
  }
}
export function throwCreationFailure(entry: DirectoryEntry): void {
  if (entry.status === "destroyed") throw new ApiError(409, "SESSION_DESTROYED", "Session has been retired.");
  if (entry.status === "initialization_failed") {
    const error = JSON.parse(entry.error_json!) as ContractError;
    throw new ContractException(error.code, error.message);
  }
}
