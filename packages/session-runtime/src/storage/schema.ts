/** Fixed replay-runtime schema. A new namespace is required; no in-place upgrades. */
export const RUNTIME_SCHEMA: readonly string[] = [
  `CREATE TABLE runtime_session (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), identity_json TEXT NOT NULL, config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  )`,
  `CREATE TABLE runtime_inbox (
    sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9007199254740991), event_id TEXT NOT NULL UNIQUE,
    received_at INTEGER NOT NULL CHECK (received_at >= 0), event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
    event_json TEXT, consumed_at INTEGER CHECK (consumed_at >= 0),
    retry_at INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
    CHECK ((consumed_at IS NULL AND event_json IS NOT NULL) OR (consumed_at IS NOT NULL AND event_json IS NULL))
  )`,
  `CREATE INDEX runtime_inbox_pending ON runtime_inbox(sequence) WHERE consumed_at IS NULL`,
  `CREATE TABLE runtime_pending_operations (
    operation_id TEXT PRIMARY KEY, source_input_sequence INTEGER NOT NULL REFERENCES runtime_inbox(sequence),
    operation_key TEXT NOT NULL, provider TEXT NOT NULL, job_id TEXT NOT NULL
  ) WITHOUT ROWID`,
];
