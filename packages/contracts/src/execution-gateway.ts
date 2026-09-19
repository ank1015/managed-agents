import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import { parseUuid } from "./llm.ts";
import { nonemptyString, record } from "./validation.ts";

/** Our routing convention inside the gateway's otherwise opaque clientContext object. */
export type ExecutionGatewayContext = { receiver: string; reference: string };
export type ExecutionGatewayEvent = {
  schemaVersion: 2; eventId: string; jobId: string; machineId: string;
  type: "job.succeeded" | "job.failed" | "job.unknown";
  completedAt: string; clientContext: ExecutionGatewayContext;
};
export type GatewayEventReceipt = {
  status: "accepted"; eventId: string; jobId: string; clientContext: ExecutionGatewayContext;
};
/** Private callback-only service binding. Does not authorize submission of new work. */
export interface GatewayEventReceiverBinding { acceptGatewayEvent(serialized: string): Promise<string> }

export function parseExecutionGatewayContext(value: unknown): ExecutionGatewayContext {
  const r = record(parseJsonValue(value), ["receiver", "reference"], "clientContext");
  const receiver = nonemptyString(r.receiver, "receiver"), reference = nonemptyString(r.reference, "reference");
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(receiver) || reference.length > 2048) {
    throw new ContractException("INVALID_REQUEST", "Invalid gateway callback routing identifiers.");
  }
  return { receiver, reference };
}
export function parseExecutionGatewayEvent(value: unknown): ExecutionGatewayEvent {
  const r = record(parseJsonValue(value), ["schemaVersion", "eventId", "jobId", "machineId", "type", "completedAt", "clientContext"], "gateway event");
  if (r.schemaVersion !== 2 || !["job.succeeded", "job.failed", "job.unknown"].includes(String(r.type))
    || typeof r.completedAt !== "string" || r.completedAt.length > 100 || !Number.isFinite(Date.parse(r.completedAt))) {
    throw new ContractException("INVALID_REQUEST", "Invalid gateway terminal event.");
  }
  return { schemaVersion: 2, eventId: parseUuid(r.eventId), jobId: parseUuid(r.jobId), machineId: parseUuid(r.machineId),
    type: r.type as ExecutionGatewayEvent["type"], completedAt: r.completedAt,
    clientContext: parseExecutionGatewayContext(r.clientContext) };
}
export function parseGatewayEventReceipt(value: unknown): GatewayEventReceipt {
  const r = record(parseJsonValue(value), ["status", "eventId", "jobId", "clientContext"], "gateway event receipt");
  if (r.status !== "accepted") throw new ContractException("INVALID_REQUEST", "Gateway event was not accepted.");
  return { status: "accepted", eventId: parseUuid(r.eventId), jobId: parseUuid(r.jobId), clientContext: parseExecutionGatewayContext(r.clientContext) };
}
