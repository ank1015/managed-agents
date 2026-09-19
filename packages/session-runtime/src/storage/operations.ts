import type { SqlStorage } from "@cloudflare/workers-types";
import { ContractException, jsonEquals, RUNTIME_EVENT_ID_PREFIX } from "@managed-agents/contracts";
import type {
  CompletionReceipt, JsonValue, OperationCompletion, OperationCorrelation, OperationDefinition, OperationOutcome, OperationRequest,
  ProviderSubmission, ProviderStatusQuery, ProviderSubmitResult, ProviderStatusResult, SessionInfo,
} from "@managed-agents/contracts";
import type { RuntimeStorage } from "../types.ts";
import { insertInput } from "./inbox.ts";
import { allocateSequence } from "./session.ts";
import { deleteJson, readJson, writeJson } from "@managed-agents/sqlite-json";

type OperationRow = {
  operation_id: string; submission_id: string; provider: string; type: string; version: string;
  job_id: string | null; outcome_json: string | null; completion_event_id: string | null;
  created_at: number; completed_at: number | null; caused_by_event_id: string | null;
  reconcile_at: number | null; reconcile_attempts: number; reconcile_token: string | null; reconcile_error: string | null;
};

export interface OperationInfo extends OperationCorrelation, OperationDefinition {
  jobId: string | null;
  outcome: OperationOutcome | null;
  createdAt: number;
  completedAt: number | null;
  causedByEventId: string | null;
  completionEventId: string | null;
  reconcileError: string | null;
}

interface Attempt {
  provider: string;
  token: string;
  attempt: number;
}
export type SubmissionAction = Attempt & ProviderSubmission & { kind: "submit" };
export type StatusAction = Attempt & ProviderStatusQuery & { kind: "status" };
export type DeliveryAction = SubmissionAction | StatusAction;

export function insertOperation(sql: SqlStorage, session: SessionInfo, request: OperationRequest, cause: string | null, now: number): string {
  const operationId = crypto.randomUUID();
  // Tuple encoding is unambiguous even when session identifiers contain separators.
  const { sessionId, harness } = session.identity;
  const submissionId = JSON.stringify([sessionId, harness.id, harness.version, operationId]);
  sql.exec(`INSERT INTO runtime_operations(operation_id, submission_id, provider, type, version, caused_by_event_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, operationId, submissionId, request.provider, request.type, request.version, cause, now).toArray();
  sql.exec("INSERT INTO runtime_outbox(operation_id, input_json, state, due_at) VALUES (?, ?, 'pending', ?)",
    operationId, writeJson(sql, "runtime_json_chunks", request.input), now).toArray();
  return operationId;
}

/** Internal persistence boundary. All methods that change multiple records own a synchronous transaction. */
export class OperationStore {
  private readonly storage: RuntimeStorage;
  constructor(storage: RuntimeStorage) { this.storage = storage; }
  get sql(): SqlStorage { return this.storage.sql; }

  #row(id: string): OperationRow {
    const row = this.sql.exec<OperationRow>("SELECT * FROM runtime_operations WHERE operation_id = ?", id).toArray()[0];
    if (!row) throw new ContractException("OPERATION_NOT_FOUND", "Unknown local operation.");
    return row;
  }

  get(id: string): OperationInfo {
    const row = this.#row(id);
    return {
      operationId: id, submissionId: row.submission_id, provider: row.provider, type: row.type, version: row.version,
      jobId: row.job_id, outcome: row.outcome_json === null ? null : readJson<OperationOutcome>(this.sql, "runtime_json_chunks", row.outcome_json),
      createdAt: row.created_at, completedAt: row.completed_at, causedByEventId: row.caused_by_event_id,
      completionEventId: row.completion_event_id,
      reconcileError: row.reconcile_error,
    };
  }

  #checkJob(row: OperationRow, jobId: string): void {
    if (row.job_id !== null && row.job_id !== jobId) {
      throw new ContractException("COMPLETION_CONFLICT", "Provider job differs from the stored operation job.");
    }
  }

  #complete(row: OperationRow, outcome: OperationOutcome, now: number, jobId: string | null): CompletionReceipt {
    if (jobId !== null) this.#checkJob(row, jobId);
    if (row.outcome_json !== null) {
      if (!jsonEquals(readJson<OperationOutcome>(this.sql, "runtime_json_chunks", row.outcome_json), outcome)) {
        throw new ContractException("COMPLETION_CONFLICT", "Operation already has a different terminal outcome.");
      }
      return { operationId: row.operation_id, eventId: row.completion_event_id!, duplicate: true };
    }
    const eventId = `${RUNTIME_EVENT_ID_PREFIX}operation:${row.operation_id}`;
    insertInput(this.sql, {
      eventId, sequence: allocateSequence(this.sql), receivedAt: now,
      event: { type: "runtime.operation.completed", payload: { operationId: row.operation_id, outcome } },
    });
    this.sql.exec(`UPDATE runtime_operations SET job_id = ?, outcome_json = ?, completed_at = ?,
      completion_event_id = ?, reconcile_at = NULL, reconcile_token = NULL, reconcile_error = NULL WHERE operation_id = ?`,
    jobId ?? row.job_id, writeJson(this.sql, "runtime_json_chunks", outcome), now, eventId, row.operation_id).toArray();
    this.#deleteOutbox(row.operation_id);
    return { operationId: row.operation_id, eventId, duplicate: false };
  }

  #deleteOutbox(operationId: string): void {
    const row = this.sql.exec<{ input_json: string }>("SELECT input_json FROM runtime_outbox WHERE operation_id = ?", operationId).toArray()[0];
    if (row) deleteJson(this.sql, "runtime_json_chunks", row.input_json);
    this.sql.exec("DELETE FROM runtime_outbox WHERE operation_id = ?", operationId).toArray();
  }

  accept(value: OperationCompletion, now: number): CompletionReceipt {
    return this.storage.transactionSync(() => {
      const row = this.#row(value.operationId);
      if (value.submissionId !== row.submission_id || value.provider !== row.provider) {
        throw new ContractException("COMPLETION_CONFLICT", "Completion does not match the expected provider and submission.");
      }
      return this.#complete(row, value.outcome, now, value.jobId);
    });
  }

  /** A lease deadline recovers an interrupted attempt; an attempt token fences stale responses. */
  claim(now: number, leaseMs: number): DeliveryAction | undefined {
    return this.storage.transactionSync(() => {
      const candidate = this.sql.exec<{ operation_id: string; kind: "submit" | "status" }>(`
        SELECT operation_id, 'submit' AS kind, due_at AS due FROM runtime_outbox WHERE due_at <= ?
        UNION ALL
        SELECT operation_id, 'status' AS kind, reconcile_at AS due FROM runtime_operations WHERE reconcile_at <= ? AND outcome_json IS NULL
        ORDER BY due, operation_id LIMIT 1`, now, now).toArray()[0];
      if (!candidate) return;
      const token = crypto.randomUUID();
      const op = this.#row(candidate.operation_id);
      const correlation = { operationId: op.operation_id, submissionId: op.submission_id, provider: op.provider, token };
      if (candidate.kind === "submit") {
        const outbox = this.sql.exec<{ attempts: number; input_json: string }>(`UPDATE runtime_outbox SET state = 'submitting',
          attempts = attempts + 1, attempt_token = ?, due_at = ? WHERE operation_id = ? RETURNING attempts, input_json`,
        token, now + leaseMs, candidate.operation_id).one();
        return { ...correlation, kind: "submit", attempt: outbox.attempts,
          request: { provider: op.provider, type: op.type, version: op.version, input: readJson<JsonValue>(this.sql, "runtime_json_chunks", outbox.input_json) } };
      }
      if (op.job_id === null) throw new Error("Cannot reconcile an operation without an accepted job.");
      const attempt = this.sql.exec<{ reconcile_attempts: number }>(`UPDATE runtime_operations SET
        reconcile_attempts = reconcile_attempts + 1, reconcile_token = ?, reconcile_at = ?
        WHERE operation_id = ? RETURNING reconcile_attempts`, token, now + leaseMs, candidate.operation_id).one().reconcile_attempts;
      return { ...correlation, kind: "status", jobId: op.job_id, attempt };
    });
  }

  #current(action: DeliveryAction): OperationRow | undefined {
    const row = this.#row(action.operationId);
    if (row.outcome_json !== null) return;
    const token = action.kind === "status" ? row.reconcile_token
      : this.sql.exec<{ attempt_token: string | null }>("SELECT attempt_token FROM runtime_outbox WHERE operation_id = ?", action.operationId).toArray()[0]?.attempt_token;
    return token === action.token ? row : undefined;
  }

  submitted(action: SubmissionAction, result: ProviderSubmitResult, now: number, reconcileMs: number): void {
    this.storage.transactionSync(() => {
      const row = this.#current(action);
      // A callback may have completed this operation while submit was awaiting its response.
      if (!row) return;
      if (result.status === "rejected") {
        if (row.job_id !== null) throw new ContractException("COMPLETION_CONFLICT", "An accepted job cannot subsequently be rejected at submission.");
        this.#complete(row, { status: "failed", origin: "submission", error: result.error }, now, null);
        return;
      }
      this.#checkJob(row, result.jobId);
      if (result.status === "completed") {
        this.#complete(row, result.outcome, now, result.jobId);
        return;
      }
      this.sql.exec(`UPDATE runtime_operations SET job_id = ?, reconcile_at = ?, reconcile_attempts = 0, reconcile_error = NULL WHERE operation_id = ?`,
        result.jobId, now + reconcileMs, action.operationId).toArray();
      this.#deleteOutbox(action.operationId);
    });
  }

  reconciled(action: StatusAction, result: ProviderStatusResult, now: number, reconcileMs: number): void {
    this.storage.transactionSync(() => {
      const row = this.#current(action);
      if (!row) return;
      if (result.status === "completed") {
        this.#complete(row, result.outcome, now, row.job_id);
      } else if (result.status === "missing") {
        // The worker owns recovery after acceptance. The driver retries status checks only.
        throw new Error("Provider reported a missing accepted job; execution recovery belongs to the operation worker.");
      } else {
        this.sql.exec(`UPDATE runtime_operations SET reconcile_at = ?, reconcile_token = NULL, reconcile_attempts = 0, reconcile_error = NULL WHERE operation_id = ?`,
          now + reconcileMs, action.operationId).toArray();
      }
    });
  }

  retry(action: DeliveryAction, due: number, message: string): void {
    this.storage.transactionSync(() => {
      if (!this.#current(action)) return;
      if (action.kind === "submit") {
        this.sql.exec("UPDATE runtime_outbox SET state = 'pending', attempt_token = NULL, due_at = ?, last_error = ? WHERE operation_id = ?",
          due, message, action.operationId).toArray();
      } else {
        this.sql.exec("UPDATE runtime_operations SET reconcile_token = NULL, reconcile_at = ?, reconcile_error = ? WHERE operation_id = ?",
          due, message, action.operationId).toArray();
      }
    });
  }

  nextDeadline(): number | null {
    return this.sql.exec<{ due: number | null }>(`SELECT MIN(due) AS due FROM (
      SELECT MIN(due_at) AS due FROM runtime_outbox
      UNION ALL SELECT MIN(reconcile_at) AS due FROM runtime_operations WHERE outcome_json IS NULL
    )`).one().due;
  }
}
