import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { nonemptyString, record } from "./validation.ts";

export type OperationId = string;
/** Wire payload bounds; persistence uses chunked SQLite rows for large JSON. */
export const MAX_OPERATION_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_OPERATION_OUTCOME_BYTES = 8 * 1024 * 1024;

export function assertJsonSize(value: JsonValue, maximum: number): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) {
    throw new ContractException("INVALID_REQUEST", `JSON payload exceeds ${maximum} bytes.`);
  }
}

/** A supported operation on a logical provider, never a URL or credentials. */
export interface OperationDefinition {
  provider: string;
  type: string;
  version: string;
}

export interface OperationRequest extends OperationDefinition {
  input: JsonValue;
}

export type OperationFailure = { code: string; message: string; details?: JsonValue };
export type OperationOutcome =
  | { status: "succeeded"; result: JsonValue }
  | { status: "failed"; origin: "submission" | "execution"; error: OperationFailure }
  | { status: "cancelled" };

/** Persisted before dispatch; echoed by callbacks, including callbacks preceding the submit response. */
export interface OperationCorrelation {
  operationId: OperationId;
  submissionId: string;
}

export interface ProviderSubmission extends OperationCorrelation {
  request: OperationRequest;
}

export interface ProviderStatusQuery extends OperationCorrelation {
  jobId: string;
}

export type ProviderSubmitResult =
  /** The worker durably owns execution and recovery; the session may discard its input. */
  | { status: "accepted"; jobId: string }
  | { status: "completed"; jobId: string; outcome: OperationOutcome }
  | { status: "rejected"; error: OperationFailure };

export type ProviderStatusResult =
  | { status: "pending" }
  | { status: "completed"; outcome: OperationOutcome }
  /** A recovery/contract error for an accepted job; never authorizes resubmission. */
  | { status: "missing" };

/** The host authenticates the provider before passing this normalized value to the runtime. */
export interface OperationCompletion extends OperationCorrelation {
  provider: string;
  jobId: string;
  outcome: OperationOutcome;
}

export type OperationCompletedEvent = {
  type: "runtime.operation.completed";
  payload: { operationId: OperationId; outcome: OperationOutcome };
};
export type RuntimeEvent = OperationCompletedEvent;

export interface CompletionReceipt {
  operationId: OperationId;
  eventId: string;
  duplicate: boolean;
}

/** Both namespaces are reserved at external input admission. */
export const RUNTIME_EVENT_PREFIX = "runtime.";
export const RUNTIME_EVENT_ID_PREFIX = "runtime:";

function required(value: JsonValue | undefined, path: string): JsonValue {
  if (value === undefined) throw new ContractException("INVALID_REQUEST", `${path} is required.`);
  return value;
}

export function parseOperationDefinition(value: unknown): OperationDefinition {
  const r = record(parseJsonValue(value), ["provider", "type", "version"], "operation definition");
  return {
    provider: nonemptyString(r.provider, "provider"), type: nonemptyString(r.type, "type"),
    version: nonemptyString(r.version, "version"),
  };
}

export function parseOperationRequest(value: unknown): OperationRequest {
  const r = record(parseJsonValue(value), ["provider", "type", "version", "input"], "operation");
  const input = required(r.input, "input");
  assertJsonSize(input, MAX_OPERATION_INPUT_BYTES);
  return {
    ...parseOperationDefinition({ provider: r.provider, type: r.type, version: r.version }),
    input,
  };
}

export function parseProviderSubmission(value: unknown): ProviderSubmission {
  const r = record(parseJsonValue(value), ["operationId", "submissionId", "request"], "submission");
  return {
    operationId: nonemptyString(r.operationId, "operationId"), submissionId: nonemptyString(r.submissionId, "submissionId"),
    request: parseOperationRequest(r.request),
  };
}

export function parseProviderStatusQuery(value: unknown): ProviderStatusQuery {
  const r = record(parseJsonValue(value), ["operationId", "submissionId", "jobId"], "status query");
  return {
    operationId: nonemptyString(r.operationId, "operationId"), submissionId: nonemptyString(r.submissionId, "submissionId"),
    jobId: nonemptyString(r.jobId, "jobId"),
  };
}

export function parseOperationFailure(value: unknown): OperationFailure {
  const r = record(parseJsonValue(value), ["code", "message", "details"], "error");
  return {
    code: nonemptyString(r.code, "error.code"), message: nonemptyString(r.message, "error.message"),
    ...(r.details === undefined ? {} : { details: r.details }),
  };
}

export function parseOperationOutcome(value: unknown): OperationOutcome {
  const json = parseJsonValue(value);
  assertJsonSize(json, MAX_OPERATION_OUTCOME_BYTES);
  const r = record(json, ["status", "result", "origin", "error"], "outcome");
  switch (r.status) {
    case "succeeded":
      record(json, ["status", "result"], "outcome");
      return { status: "succeeded", result: required(r.result, "result") };
    case "failed":
      record(json, ["status", "origin", "error"], "outcome");
      if (r.origin !== "submission" && r.origin !== "execution") break;
      return { status: "failed", origin: r.origin, error: parseOperationFailure(r.error) };
    case "cancelled":
      record(json, ["status"], "outcome");
      return { status: "cancelled" };
  }
  throw new ContractException("INVALID_REQUEST", "Invalid operation outcome.");
}

export function parseOperationCompletion(value: unknown): OperationCompletion {
  const r = record(parseJsonValue(value), ["operationId", "submissionId", "provider", "jobId", "outcome"], "completion");
  return {
    operationId: nonemptyString(r.operationId, "operationId"), submissionId: nonemptyString(r.submissionId, "submissionId"),
    provider: nonemptyString(r.provider, "provider"), jobId: nonemptyString(r.jobId, "jobId"),
    outcome: parseJobOutcome(r.outcome),
  };
}

export function parseProviderSubmitResult(value: unknown): ProviderSubmitResult {
  const json = parseJsonValue(value);
  const r = record(json, ["status", "jobId", "outcome", "error"], "submission result");
  switch (r.status) {
    case "accepted":
      record(json, ["status", "jobId"], "submission result");
      return { status: "accepted", jobId: nonemptyString(r.jobId, "jobId") };
    case "completed":
      record(json, ["status", "jobId", "outcome"], "submission result");
      return { status: "completed", jobId: nonemptyString(r.jobId, "jobId"), outcome: parseJobOutcome(r.outcome) };
    case "rejected":
      record(json, ["status", "error"], "submission result");
      return { status: "rejected", error: parseOperationFailure(r.error) };
  }
  throw new ContractException("INVALID_REQUEST", "Invalid provider submission result.");
}

export function parseProviderStatusResult(value: unknown): ProviderStatusResult {
  const json = parseJsonValue(value);
  const r = record(json, ["status", "outcome"], "status result");
  if (r.status === "completed") return { status: "completed", outcome: parseJobOutcome(r.outcome) };
  if (r.status === "pending" || r.status === "missing") {
    record(json, ["status"], "status result");
    return { status: r.status };
  }
  throw new ContractException("INVALID_REQUEST", "Invalid provider status result.");
}

function parseJobOutcome(value: unknown): OperationOutcome {
  const outcome = parseOperationOutcome(value);
  if (outcome.status === "failed" && outcome.origin === "submission") {
    throw new ContractException("INVALID_REQUEST", "An accepted provider job cannot report submission rejection as its outcome.");
  }
  return outcome;
}
