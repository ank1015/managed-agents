import { ContractException } from "./errors.ts";
import type { ContractError } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { HarnessIdentity, SessionInfo } from "./session.ts";
import { nonemptyString, record } from "./validation.ts";

export interface CreateSessionRequest {
  /** Stable across retries. */
  requestId: string;
  harness: HarnessIdentity;
  config: JsonValue;
  metadata: { [key: string]: JsonValue };
}

export interface CreateSessionResult { session: SessionInfo; duplicate: boolean }

export const SESSION_STATUSES = ["idle", "running", "failed", "cancelling", "cancelled", "waiting"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionRecord {
  sessionId: string;
  harness: HarnessIdentity;
  metadata: { [key: string]: JsonValue };
  status: SessionStatus;
}

export interface ListSessionsResult { sessions: SessionRecord[] }

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest {
  const request = record(parseJsonValue(value), ["requestId", "harness", "config", "metadata"], "request");
  const harness = record(request.harness, ["id", "version"], "harness");
  const requestId = nonemptyString(request.requestId, "requestId");
  if (requestId.length > 200) throw new ContractException("INVALID_REQUEST", "requestId must be at most 200 characters.");
  if (!Object.hasOwn(request, "config")) throw new ContractException("INVALID_REQUEST", "config is required.");
  if (!Object.hasOwn(request, "metadata") || request.metadata === null || typeof request.metadata !== "object" || Array.isArray(request.metadata)) {
    throw new ContractException("INVALID_REQUEST", "metadata must be a JSON object.");
  }
  return { requestId, harness: { id: nonemptyString(harness.id, "harness.id"), version: nonemptyString(harness.version, "harness.version") },
    config: request.config!, metadata: request.metadata };
}

/** Trusted binding protocol. JSON strings avoid recursively expanding JsonValue in RPC types. */
export type SessionCommand =
  | { action: "initialize" | "appendInput" | "acceptCompletion"; value: JsonValue }
  | { action: "getOperation"; value: string }
  | { action: "getMessages" | "getPendingMessages"; value: MessagePageQuery }
  | { action: "getSession" | "getProgress" };
export interface MessagePageQuery { after: number; limit: number }
export function parseMessagePageQuery(value: unknown): MessagePageQuery {
  const r = record(parseJsonValue(value), ["after", "limit"], "message page");
  const after = r.after ?? 0, limit = r.limit ?? 100;
  if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || r.after === null || r.limit === null) throw new ContractException("INVALID_REQUEST", "after must be a nonnegative integer; limit must be 1–100.");
  return { after, limit };
}
export type SessionReply<T> = { ok: true; value: T } | { ok: false; error: ContractError };

export function parseSessionCommand(value: unknown): SessionCommand {
  const command = record(parseJsonValue(value), ["action", "value"], "command");
  switch (command.action) {
    case "getMessages": case "getPendingMessages": return { action: command.action, value: parseMessagePageQuery(command.value) };
    case "getSession": case "getProgress":
      if (Object.hasOwn(command, "value")) throw new ContractException("INVALID_REQUEST", "Unexpected command value.");
      return { action: command.action };
    case "getOperation": return { action: command.action, value: nonemptyString(command.value, "operationId") };
    case "initialize": case "appendInput": case "acceptCompletion":
      if (!Object.hasOwn(command, "value")) throw new ContractException("INVALID_REQUEST", "Missing command value.");
      return { action: command.action, value: command.value! };
    default: throw new ContractException("INVALID_REQUEST", "Unknown session command.");
  }
}
