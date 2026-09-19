import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { nonemptyString, record } from "./validation.ts";

export type SessionId = string;

export interface HarnessIdentity {
  id: string;
  /** Behavior version, independent of schema and deployment versions. */
  version: string;
}

export interface SessionIdentity {
  sessionId: SessionId;
  harness: HarnessIdentity;
}

export interface InitializeSessionRequest {
  session: SessionIdentity;
  config: JsonValue;
}

export interface SessionInfo<Config = JsonValue> {
  identity: SessionIdentity;
  config: Config;
  /** Unix milliseconds assigned by the runtime. */
  createdAt: number;
}

export interface InitializeSessionResult {
  session: SessionInfo;
  duplicate: boolean;
}

export function parseInitializeSessionRequest(value: unknown): InitializeSessionRequest {
  const request = record(parseJsonValue(value), ["session", "config"], "request");
  const session = record(request.session, ["sessionId", "harness"], "session");
  const harness = record(session.harness, ["id", "version"], "session.harness");
  if (!Object.hasOwn(request, "config")) {
    throw new ContractException("INVALID_REQUEST", "config is required.");
  }
  return {
    session: {
      sessionId: nonemptyString(session.sessionId, "session.sessionId"),
      harness: {
        id: nonemptyString(harness.id, "session.harness.id"),
        version: nonemptyString(harness.version, "session.harness.version"),
      },
    },
    config: request.config!,
  };
}
