CREATE TABLE bash_operations (
  submission_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  timeout_seconds REAL,
  request_hash TEXT NOT NULL,
  gateway_key TEXT NOT NULL UNIQUE,
  gateway_job_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('submitting', 'accepted', 'terminal', 'rejected')),
  rejection_json TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  UNIQUE (route_key, session_id, operation_id)
);
CREATE INDEX bash_operations_due ON bash_operations(next_attempt_at)
  WHERE delivered_at IS NULL AND state != 'rejected';
