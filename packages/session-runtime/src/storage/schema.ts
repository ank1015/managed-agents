import type { SqlMigration } from "@managed-agents/harness-api";
import { jsonChunksSchema } from "@managed-agents/sqlite-json";

// Migration history is the bootstrap table and is deliberately outside its own history.
export const MIGRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS runtime_migrations (
  scope TEXT NOT NULL CHECK (scope IN ('runtime', 'harness')),
  version INTEGER NOT NULL CHECK (version > 0),
  statements_json TEXT NOT NULL,
  PRIMARY KEY (scope, version)
)`;

export const RUNTIME_MIGRATIONS: readonly SqlMigration[] = [{
  version: 1,
  statements: [
    `CREATE TABLE runtime_session (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      identity_json TEXT NOT NULL,
      original_config_json TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      last_input_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_input_sequence BETWEEN 0 AND 9007199254740991)
    )`,
    `CREATE TABLE runtime_inbox (
      event_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE CHECK (sequence BETWEEN 1 AND 9007199254740991),
      received_at INTEGER NOT NULL CHECK (received_at >= 0),
      event_json TEXT NOT NULL,
      consumed_at INTEGER CHECK (consumed_at >= 0)
    )`,
    `CREATE INDEX runtime_inbox_pending ON runtime_inbox (sequence) WHERE consumed_at IS NULL`,
  ],
}, {
  version: 2,
  statements: [
    `CREATE TABLE runtime_operations (
      operation_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      type TEXT NOT NULL,
      version TEXT NOT NULL,
      caused_by_event_id TEXT REFERENCES runtime_inbox(event_id),
      created_at INTEGER NOT NULL,
      job_id TEXT,
      outcome_json TEXT,
      completed_at INTEGER,
      completion_event_id TEXT UNIQUE REFERENCES runtime_inbox(event_id),
      reconcile_at INTEGER,
      reconcile_attempts INTEGER NOT NULL DEFAULT 0,
      reconcile_token TEXT,
      reconcile_error TEXT
    )`,
    `CREATE INDEX runtime_operations_reconcile ON runtime_operations(reconcile_at) WHERE reconcile_at IS NOT NULL`,
    `CREATE TABLE runtime_outbox (
      operation_id TEXT PRIMARY KEY REFERENCES runtime_operations(operation_id),
      input_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'submitting')),
      attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL,
      attempt_token TEXT,
      last_error TEXT
    )`,
    `CREATE INDEX runtime_outbox_due ON runtime_outbox(due_at)`,
    `CREATE TABLE runtime_progress (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      failed_event_id TEXT REFERENCES runtime_inbox(event_id),
      failures INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER,
      blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
      last_error TEXT
    )`,
    `INSERT INTO runtime_progress(singleton) VALUES (1)`,
  ],
}, {
  version: 3,
  statements: [jsonChunksSchema("runtime_json_chunks")],
}];
