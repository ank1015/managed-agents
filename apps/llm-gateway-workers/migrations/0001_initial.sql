CREATE TABLE llm_operations (
  submission_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
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
CREATE INDEX llm_operations_due ON llm_operations(next_attempt_at)
  WHERE delivered_at IS NULL AND state != 'rejected';

CREATE TABLE llm_webhook_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('job.succeeded', 'job.failed', 'job.cancelled')),
  completed_at TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT
);
CREATE INDEX llm_webhook_events_due ON llm_webhook_events(next_attempt_at) WHERE processed_at IS NULL;
