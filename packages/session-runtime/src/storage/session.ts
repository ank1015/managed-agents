import type { SqlStorage } from "@cloudflare/workers-types";
import { ContractException } from "@managed-agents/contracts";
import type { JsonValue, SessionIdentity, SessionInfo } from "@managed-agents/contracts";

export interface StoredSession {
  info: SessionInfo;
  originalConfig: JsonValue;
}

export function findSession(sql: SqlStorage): StoredSession | undefined {
  const row = sql.exec<{
    identity_json: string; original_config_json: string; config_json: string; created_at: number;
  }>("SELECT identity_json, original_config_json, config_json, created_at FROM runtime_session WHERE singleton = 1").toArray()[0];
  if (!row) return undefined;
  return {
    info: { identity: JSON.parse(row.identity_json) as SessionIdentity, config: JSON.parse(row.config_json) as JsonValue, createdAt: row.created_at },
    originalConfig: JSON.parse(row.original_config_json) as JsonValue,
  };
}

export function requireSession(sql: SqlStorage): StoredSession {
  const session = findSession(sql);
  if (!session) throw new ContractException("SESSION_NOT_INITIALIZED", "Initialize the session first.");
  return session;
}

export function insertSession(sql: SqlStorage, info: SessionInfo, originalConfig: JsonValue): void {
  sql.exec(`INSERT INTO runtime_session
    (singleton, identity_json, original_config_json, config_json, created_at) VALUES (1, ?, ?, ?, ?)`,
  JSON.stringify(info.identity), JSON.stringify(originalConfig), JSON.stringify(info.config), info.createdAt).toArray();
}

/** Caller owns the transaction; allocation rolls back with its associated record. */
export function allocateSequence(sql: SqlStorage): number {
  const column = "last_input_sequence";
  const { sequence } = sql.exec<{ sequence: number }>(`SELECT ${column} AS sequence FROM runtime_session WHERE singleton = 1`).one();
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error("input sequence exhausted or invalid.");
  }
  const next = sequence + 1;
  sql.exec(`UPDATE runtime_session SET ${column} = ? WHERE singleton = 1`, next).toArray();
  return next;
}
