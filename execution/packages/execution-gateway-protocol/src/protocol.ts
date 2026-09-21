import { bool, bytes, identity, invalid, jsonValue, messageText, object, text, uuid } from "./validation.ts";
import type { Json } from "./validation.ts";
import { digest } from "./crypto.ts";
export const PROTOCOL_VERSION = 1;
export const MAX_NATIVE_BYTES = 8 * 1024 * 1024;
export const MAX_HTTP_BYTES = MAX_NATIVE_BYTES + 64 * 1024;
export const MAX_FRAME_BYTES = MAX_NATIVE_BYTES + 128 * 1024;
export const OPERATIONS = ["request.cancel", "runtime.capabilities",
  "execution.exec", "execution.interact", "execution.close", "filesystem.read", "filesystem.write", "filesystem.patch",
  "repl.execute", "repl.collect", "repl.interrupt", "repl.reset", "repl.close"] as const;
export type OperationName = typeof OPERATIONS[number];
export function operationName(value: unknown): OperationName {
  if (typeof value !== "string" || !(OPERATIONS as readonly string[]).includes(value)) throw invalid("Unsupported native operation.");
  return value as OperationName;
}
export interface Callback { receiver: string; context: Json }
export function callback(value: unknown): Callback {
  const o = object(value, ["receiver", "context"]);
  const context = o.context === undefined ? null : jsonValue(o.context);
  if (bytes(JSON.stringify(context)) > 8192) throw invalid("Callback context exceeds 8 KiB.");
  return { receiver: identity(o.receiver), context };
}
export interface Submission {
  requestId: string; runtimeGeneration: string;
  operation: { operation: OperationName; params: Json };
  callback: Callback;
}
export function submission(value: unknown): Submission {
  const o = object(value, ["requestId", "runtimeGeneration", "operation", "callback"]), op = object(o.operation, ["operation", "params"]);
  const params = jsonValue(object(op.params));
  if (bytes(JSON.stringify(params)) > MAX_NATIVE_BYTES) throw invalid("Native parameters exceed limit.");
  return { requestId: identity(o.requestId), runtimeGeneration: uuid(o.runtimeGeneration),
    operation: { operation: operationName(op.operation), params }, callback: callback(o.callback) };
}
export interface RoutingEnvelope {
  machineId: string; runtimeGeneration: string; requestId: string; requestHash: string; callback: Callback;
}
export function routingFields(value: unknown): RoutingEnvelope {
  const o = object(value);
  return { machineId: uuid(o.machineId), runtimeGeneration: uuid(o.runtimeGeneration), requestId: identity(o.requestId),
    requestHash: digest(o.requestHash), callback: callback(o.callback) };
}
export interface Hello {
  type: "hello"; protocolVersion: 1; runtimeGeneration: string; daemonVersion: string; os: string; arch: string; operations: OperationName[];
}
export function hello(value: unknown): Hello {
  const o = object(value, ["type", "protocolVersion", "runtimeGeneration", "daemonVersion", "os", "arch", "operations"]);
  if (o.type !== "hello" || o.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(o.operations) || o.operations.length > OPERATIONS.length) throw invalid("Unsupported daemon hello.");
  const operations = o.operations.map(operationName); if (new Set(operations).size !== operations.length) throw invalid("Duplicate capability.");
  return { type: "hello", protocolVersion: 1, runtimeGeneration: uuid(o.runtimeGeneration), daemonVersion: text(o.daemonVersion, 128), os: text(o.os, 64), arch: text(o.arch, 64), operations };
}
export type Outcome = { status: "ok"; result: Json } | { status: "error"; error: { code: string; message: string; uncertain: boolean } };
export function outcome(value: unknown): Outcome {
  const o = object(value);
  if (o.status === "ok") { object(o, ["status", "result"]); return { status: "ok", result: jsonValue(o.result) }; }
  if (o.status === "error") { object(o, ["status", "error"]); const e = object(o.error, ["code", "message", "uncertain"]); return { status: "error", error: { code: identity(e.code), message: messageText(e.message, 8192), uncertain: bool(e.uncertain) } }; }
  throw invalid("Invalid native outcome.");
}
export interface CompletionEvent extends RoutingEnvelope { protocolVersion: 1; deliveryId: string; resultHash: string; outcome: Outcome }
export interface CompletionReceipt { status: "accepted"; deliveryId: string; requestId: string; requestHash: string; resultHash: string }
export type CompletionReply = CompletionReceipt | { status: "rejected"; code: string; retryable: boolean };
export interface CompletionReceiver { acceptExecutionResult(event: CompletionEvent): Promise<CompletionReply> }
export type SecretKind = "daemon" | "execution";
export function secretKind(value: unknown): SecretKind {
  if (value !== "daemon" && value !== "execution") throw invalid("Expected daemon or execution secret.");
  return value;
}
export interface MachineView {
  machineId: string; name: string; deleted: boolean; daemonSecretVersion: number; executionSecretVersion: number;
  connectionEpoch: number; createdAt: number; lastConnectedAt: number | null; lastDisconnectedAt: number | null;
  connectionStatus: "offline" | "connecting" | "ready"; runtimeGeneration: string | null; lastSeenAt: number | null;
  daemon: Omit<Hello, "type" | "protocolVersion" | "runtimeGeneration"> | null;
}
