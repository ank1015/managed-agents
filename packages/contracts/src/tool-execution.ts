import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import { parseProviderSubmission } from "./operation.ts";
import type { ProviderSubmission } from "./operation.ts";
import { parseUuid } from "./llm.ts";
import type { SessionDestination } from "./llm.ts";
import { nonemptyString, record } from "./validation.ts";

/** Server-only context supplied by the harness host, outside model input. */
export interface ToolExecutionContext {
  token: string; runtimeGeneration: string;
}
export interface ToolExecutionSubmission { destination: SessionDestination; execution: ToolExecutionContext; submission: ProviderSubmission }
export function parseToolExecutionContext(value: unknown): ToolExecutionContext {
  const r = record(parseJsonValue(value), ["token", "runtimeGeneration"], "execution context");
  const token = nonemptyString(r.token, "execution.token");
  if (token.length > 32768 || !/^[A-Za-z0-9._~-]+$/.test(token)) throw new ContractException("INVALID_REQUEST", "Invalid execution token encoding.");
  parseExecutionToken(token);
  return { token, runtimeGeneration: parseUuid(r.runtimeGeneration) };
}
function executionIdentity(value: unknown): string {
  const id = nonemptyString(parseJsonValue(value), "execution identity");
  if (id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(id)) throw new ContractException("INVALID_REQUEST", "Invalid execution identity.");
  return id;
}
export function parseToolExecutionSubmission(value: unknown): ToolExecutionSubmission {
  const r = record(parseJsonValue(value), ["destination", "execution", "submission"], "execution submission");
  const d = record(r.destination, ["routeKey", "sessionId"], "destination");
  const destination = { routeKey: executionIdentity(d.routeKey), sessionId: executionIdentity(d.sessionId) };
  const submission = parseProviderSubmission(r.submission);
  for (const id of [destination.routeKey, destination.sessionId, submission.operationId, submission.submissionId]) {
    if (id.length > 2048) throw new ContractException("INVALID_REQUEST", "Operation routing identifier is too long.");
  }
  return { destination, execution: parseToolExecutionContext(r.execution), submission };
}

/** Machine execution secret shape, shared by tools and harness-owned config validation. */
export function parseExecutionToken(value: unknown): string {
  const token = nonemptyString(parseJsonValue(value), "execution token");
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "me1" || !/^[1-9][0-9]*$/.test(parts[2]!)
    || !Number.isSafeInteger(Number(parts[2])) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3]!)) throw new ContractException("INVALID_REQUEST", "Expected a machine execution secret.");
  parseUuid(parts[1]);
  return token;
}
