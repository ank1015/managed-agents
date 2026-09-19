CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  harness_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed', 'cancelling', 'cancelled', 'waiting')),
  status_revision INTEGER NOT NULL DEFAULT 0,
  status_checked_at INTEGER NOT NULL DEFAULT 0,
  creation_request_id TEXT NOT NULL UNIQUE,
  creation_request_json TEXT NOT NULL,
  route_key TEXT NOT NULL,
  creation_state TEXT NOT NULL CHECK (creation_state IN ('initializing', 'ready', 'failed')),
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  error_json TEXT
);
CREATE INDEX sessions_status_refresh ON sessions(route_key, creation_state, status_checked_at, session_id);
