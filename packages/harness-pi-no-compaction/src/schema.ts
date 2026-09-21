/** Fixed namespace schema. Message rows are append-only: retain the highest sequence on future pruning. */
export const piNoCompactionSchema: readonly string[] = Object.freeze([
    `CREATE TABLE pi_no_compaction_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      phase TEXT NOT NULL CHECK (phase IN ('idle','llm','tools','cancelled','failed')),
      run_id TEXT,
      active_operation_id TEXT,
      active_assistant_sequence INTEGER,
      next_tool_index INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
      last_error_json TEXT
    )`,
    `CREATE TABLE pi_no_compaction_messages (
      sequence INTEGER PRIMARY KEY,
      message_json TEXT NOT NULL,
      in_context INTEGER NOT NULL CHECK (in_context IN (0,1)),
      run_id TEXT,
      source_event_id TEXT,
      source_operation_id TEXT,
      response_metadata_json TEXT
    )`,
    `CREATE TABLE pi_no_compaction_pending_messages (
      event_id TEXT PRIMARY KEY,
      input_sequence INTEGER NOT NULL UNIQUE,
      message_json TEXT NOT NULL
    )`,
    `CREATE TABLE pi_no_compaction_batch (
      call_index INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('queued','active','done')),
      operation_id TEXT UNIQUE,
      result_json TEXT
    )`,
]);
