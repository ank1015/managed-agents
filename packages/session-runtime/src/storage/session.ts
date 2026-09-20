import type { SqlStorage } from "@cloudflare/workers-types";
import type { JsonValue, SessionIdentity, SessionInfo } from "@managed-agents/contracts";

export interface StoredSession {
  info: SessionInfo;
}

export function findSession(sql: SqlStorage): StoredSession | undefined {
  const row = sql.exec<{
    identity_json: string; config_json: string; created_at: number;
  }>("SELECT identity_json, config_json, created_at FROM runtime_session WHERE singleton = 1").toArray()[0];
  if (!row) return undefined;
  return {
    info: { identity: JSON.parse(row.identity_json) as SessionIdentity, config: JSON.parse(row.config_json) as JsonValue, createdAt: row.created_at },
  };
}

export function insertSession(sql: SqlStorage, info: SessionInfo): void {
  sql.exec(`INSERT INTO runtime_session
    (singleton, identity_json, config_json, created_at) VALUES (1, ?, ?, ?)`,
  JSON.stringify(info.identity), JSON.stringify(info.config), info.createdAt).toArray();
}
