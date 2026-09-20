import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { parseUuid } from "./llm.ts";
import { nonemptyString, record } from "./validation.ts";

/** Our routing convention inside the gateway's otherwise opaque clientContext object. */
export type ExecutionGatewayContext = { receiver: string; [key: string]: JsonValue };
export type ExecutionGatewayEvent = {
  schemaVersion: 3; eventId: string; jobId: string; machineId: string;
  idempotencyKey: string; runtimeGenerationId: string | null;
  response: JsonValue; error: JsonValue;
  type: "job.succeeded" | "job.failed" | "job.unknown";
  completedAt: string; clientContext: ExecutionGatewayContext;
};
export type GatewayEventReceipt = {
  status: "accepted"; eventId: string; jobId: string; clientContext: ExecutionGatewayContext;
};
/** Private callback-only service binding. Does not authorize submission of new work. */
export interface GatewayEventReceiverBinding { acceptGatewayEvent(value: unknown): Promise<unknown> }

export function parseExecutionGatewayContext(value: unknown): ExecutionGatewayContext {
  const r = parseJsonValue(value);
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new ContractException("INVALID_REQUEST", "clientContext must be an object.");
  const receiver = nonemptyString(r.receiver, "receiver");
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(receiver)) {
    throw new ContractException("INVALID_REQUEST", "Invalid gateway callback routing identifiers.");
  }
  return { ...r, receiver };
}
export function parseExecutionGatewayEvent(value: unknown): ExecutionGatewayEvent {
  const r = record(parseJsonValue(value), ["schemaVersion", "eventId", "jobId", "machineId", "type", "completedAt", "clientContext", "idempotencyKey", "runtimeGenerationId", "response", "error"], "gateway event");
  if (r.schemaVersion !== 3 || !["job.succeeded", "job.failed", "job.unknown"].includes(String(r.type))
    || typeof r.completedAt !== "string" || r.completedAt.length > 100 || !Number.isFinite(Date.parse(r.completedAt))) {
    throw new ContractException("INVALID_REQUEST", "Invalid gateway terminal event.");
  }
  const idempotencyKey = nonemptyString(r.idempotencyKey, "idempotencyKey");
  if (new TextEncoder().encode(idempotencyKey).length > 200 || /[\s\0]/.test(idempotencyKey)) throw new ContractException("INVALID_REQUEST", "Invalid gateway idempotency key.");
  return { schemaVersion: 3, eventId: parseUuid(r.eventId), jobId: parseUuid(r.jobId), machineId: parseUuid(r.machineId),
    idempotencyKey, runtimeGenerationId: r.runtimeGenerationId === null ? null : parseUuid(r.runtimeGenerationId),
    response: parseJsonValue(r.response), error: parseJsonValue(r.error),
    type: r.type as ExecutionGatewayEvent["type"], completedAt: r.completedAt,
    clientContext: parseExecutionGatewayContext(r.clientContext) };
}
export function parseGatewayEventReceipt(value: unknown): GatewayEventReceipt {
  const r = record(parseJsonValue(value), ["status", "eventId", "jobId", "clientContext"], "gateway event receipt");
  if (r.status !== "accepted") throw new ContractException("INVALID_REQUEST", "Gateway event was not accepted.");
  return { status: "accepted", eventId: parseUuid(r.eventId), jobId: parseUuid(r.jobId), clientContext: parseExecutionGatewayContext(r.clientContext) };
}

/** Keep RPC disposal metadata outside strict JSON receipt validation. */
export function parseGatewayEventReply(reply: unknown): GatewayEventReceipt {
  if (!reply || typeof reply !== "object") throw new ContractException("INVALID_REQUEST", "Invalid gateway event reply.");
  try { return parseGatewayEventReceipt((reply as { receipt?: unknown }).receipt); }
  finally {
    const dispose = Object.getOwnPropertyDescriptor(reply, Symbol.dispose)?.value;
    if (typeof dispose === "function") dispose.call(reply);
  }
}
