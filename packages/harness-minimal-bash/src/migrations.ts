import type { SqlMigration } from "@managed-agents/harness-api";
import { jsonChunksSchema } from "@managed-agents/sqlite-json";

export const minimalBashMigrations: readonly SqlMigration[] = Object.freeze([Object.freeze({
  version: 1,
  statements: Object.freeze([
    `CREATE TABLE minimal_bash_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      phase TEXT NOT NULL CHECK (phase IN ('idle','llm','bash','cancelled','failed')),
      run_id TEXT,
      active_operation_id TEXT,
      active_assistant_sequence INTEGER,
      next_tool_index INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
      last_error_json TEXT
    )`,
    `CREATE TABLE minimal_bash_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      message_json TEXT NOT NULL,
      in_context INTEGER NOT NULL CHECK (in_context IN (0,1)),
      run_id TEXT,
      source_event_id TEXT,
      source_operation_id TEXT,
      response_metadata_json TEXT
    )`,
    `CREATE INDEX minimal_bash_messages_context ON minimal_bash_messages(sequence) WHERE in_context = 1`,
    `CREATE TABLE minimal_bash_pending_messages (
      event_id TEXT PRIMARY KEY,
      input_sequence INTEGER NOT NULL UNIQUE,
      message_json TEXT NOT NULL
    )`,
  ]),
}), Object.freeze({ version: 2, statements: Object.freeze([jsonChunksSchema("minimal_bash_json_chunks")]) })]);
