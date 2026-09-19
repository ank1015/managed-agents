CREATE TABLE gateway_callback_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  receiver TEXT NOT NULL,
  reference TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('job.succeeded', 'job.failed', 'job.unknown')),
  completed_at TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  delivered_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT
);
CREATE INDEX gateway_callback_events_due ON gateway_callback_events(next_attempt_at) WHERE delivered_at IS NULL;
