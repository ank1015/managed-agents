CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  harness_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initializing', 'initialization_failed', 'idle', 'running', 'failed', 'cancelling', 'cancelled', 'waiting', 'destroyed')),
  creation_request_id TEXT NOT NULL UNIQUE,
  creation_request_hash TEXT NOT NULL CHECK (length(creation_request_hash) = 64),
  route_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  error_json TEXT
);
