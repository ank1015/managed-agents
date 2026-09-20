import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { ProviderSubmission } from "./operation.ts";
import { parseProviderSubmission } from "./operation.ts";
import { record, nonemptyString } from "./validation.ts";

type JsonObject = { [key: string]: JsonValue };
export const LLM_OPERATION = Object.freeze({ provider: "llm", type: "generate", version: "v1" });
type MessageBase = { id?: string; timestamp?: number; metadata?: JsonObject };
export type LlmText = { type: "text"; text: string; metadata?: JsonObject };
export type LlmContent = LlmText | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original"; metadata?: JsonObject };
/** Provider-native assistant items and custom message data are opaque JSON. */
export type LlmAssistantMessage = MessageBase & { role: "assistant"; provider: "openai" | "chatgpt" | "fireworks"; content: JsonValue[] };
export type LlmMessage = LlmAssistantMessage | (MessageBase & (
  | { role: "user"; content: LlmContent[] }
  | { role: "system"; content: LlmText[] }
  | { role: "tool_result"; toolName: string; toolCallId: string; content: LlmContent[];
      outcome: { status: "success" } | { status: "error"; error: { message: string; name?: string } }; details?: JsonValue }
  | { role: "custom"; tag: string; data: JsonValue }
));
export type LlmTool = { name: string; description: string } & (
  | { type: "function"; parameters: JsonObject; outputSchema?: JsonObject; strict?: boolean }
  | { type: "custom"; format: { syntax: "lark"; definition: string } }
);
export type LlmInput =
  | { previousJobId: null; accountId: string; modelId: string; instructions?: string;
      messages: LlmMessage[]; tools: LlmTool[]; providerOptions: JsonObject }
  | { previousJobId: string; messages: LlmMessage[] };
export interface SessionDestination { routeKey: string; sessionId: string }
export interface LlmSubmission { destination: SessionDestination; submission: ProviderSubmission }
/** Structured RPC; unknown avoids recursively mapping JSON unions through Cloudflare RPC types. */
export interface LlmWorkerBinding {
  submit(value: unknown): Promise<unknown>;
}

function invalid(message: string): never { throw new ContractException("INVALID_REQUEST", message); }
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected a JSON object.");
  return value;
}
function string(value: JsonValue | undefined): string {
  if (typeof value !== "string") invalid("Expected a string.");
  return value;
}
export function parseUuid(value: JsonValue | undefined): string {
  const id = string(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) invalid("Expected a UUID.");
  return id;
}
function array(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) invalid("Expected an array.");
  return value;
}
function optionalString(r: JsonObject, key: string) { if (r[key] !== undefined) string(r[key]); }
function metadata(r: JsonObject) { if (r.metadata !== undefined) object(r.metadata); }
function content(value: JsonValue | undefined, images: boolean) {
  for (const part of array(value)) {
    const p = object(part);
    if (p.type === "text") {
      record(p, ["type", "text", "metadata"], "text"); string(p.text);
    } else if (images && p.type === "image") {
      record(p, ["type", "url", "detail", "metadata"], "image");
      if (!/^https?:\/\//.test(string(p.url))) invalid("Image URL must use HTTP or HTTPS.");
      if (p.detail !== undefined && !["auto", "low", "high", "original"].includes(string(p.detail))) invalid("Invalid image detail.");
    } else invalid("Unsupported content part.");
    metadata(p);
  }
}
function message(value: JsonValue): LlmMessage {
  const m = object(value), base = ["id", "timestamp", "metadata", "role"];
  optionalString(m, "id"); metadata(m);
  if (m.timestamp !== undefined && typeof m.timestamp !== "number") invalid("Invalid message timestamp.");
  switch (m.role) {
    case "user": case "system":
      record(m, [...base, "content"], "message"); content(m.content, m.role === "user"); break;
    case "assistant":
      record(m, [...base, "provider", "content"], "assistant");
      if (!["openai", "chatgpt", "fireworks"].includes(string(m.provider))) invalid("Invalid assistant provider.");
      array(m.content); break;
    case "tool_result": {
      record(m, [...base, "toolName", "toolCallId", "content", "outcome", "details"], "tool result");
      string(m.toolName); string(m.toolCallId); content(m.content, true);
      const outcome = object(m.outcome);
      if (outcome.status === "success") record(outcome, ["status"], "tool outcome");
      else if (outcome.status === "error") {
        record(outcome, ["status", "error"], "tool outcome");
        const error = record(outcome.error, ["message", "name"], "tool error");
        string(error.message); optionalString(error, "name");
      } else invalid("Invalid tool result outcome.");
      break;
    }
    case "custom":
      record(m, [...base, "tag", "data"], "custom message"); string(m.tag);
      if (!Object.hasOwn(m, "data")) invalid("Custom data is required."); break;
    default: invalid("Unsupported message role.");
  }
  return m as LlmMessage;
}
/** Validate a complete gateway message without normalizing or losing native assistant items. */
export function parseLlmMessage(value: unknown): LlmMessage { return message(parseJsonValue(value)); }
function tool(value: JsonValue): LlmTool {
  const t = object(value);
  string(t.name); string(t.description);
  if (t.type === "function") {
    record(t, ["type", "name", "description", "parameters", "outputSchema", "strict"], "function tool");
    object(t.parameters); if (t.outputSchema !== undefined) object(t.outputSchema);
    if (t.strict !== undefined && typeof t.strict !== "boolean") invalid("Invalid tool strict flag.");
  } else if (t.type === "custom") {
    record(t, ["type", "name", "description", "format"], "custom tool");
    const format = record(t.format, ["syntax", "definition"], "tool format");
    if (format.syntax !== "lark") invalid("Unsupported grammar syntax."); string(format.definition);
  } else invalid("Unsupported tool type.");
  return t as LlmTool;
}

/** Mirrors the gateway's normalized submission, excluding its worker-owned idempotency key. */
export function parseLlmInput(value: unknown): LlmInput {
  const r = object(parseJsonValue(value));
  const messages = array(r.messages).map(message);
  if (r.previousJobId !== undefined && r.previousJobId !== null) {
    record(r, ["previousJobId", "messages"], "continuation");
    return { previousJobId: parseUuid(r.previousJobId), messages };
  }
  record(r, ["previousJobId", "accountId", "modelId", "instructions", "messages", "tools", "providerOptions"], "LLM input");
  const modelId = nonemptyString(r.modelId, "modelId");
  if (modelId.length > 300) invalid("Model ID is too long.");
  optionalString(r, "instructions");
  return { previousJobId: null, accountId: parseUuid(r.accountId), modelId, messages,
    ...(r.instructions === undefined ? {} : { instructions: r.instructions as string }),
    tools: r.tools === undefined ? [] : array(r.tools).map(tool),
    providerOptions: r.providerOptions === undefined ? {} : object(r.providerOptions) };
}

export function parseLlmSubmission(value: unknown): LlmSubmission {
  const r = record(parseJsonValue(value), ["destination", "submission"], "LLM submission");
  const d = record(r.destination, ["routeKey", "sessionId"], "destination");
  const destination = { routeKey: nonemptyString(d.routeKey, "routeKey"), sessionId: nonemptyString(d.sessionId, "sessionId") };
  const submission = parseProviderSubmission(r.submission);
  for (const id of [destination.routeKey, destination.sessionId, submission.operationId, submission.submissionId]) {
    if (id.length > 2048) invalid("Operation routing identifier is too long.");
  }
  return { destination, submission };
}

export type LlmResponse = {
  id: string; modelId: string; resolvedModelId?: string; message: LlmAssistantMessage;
  stopReason: "stop" | "length" | "tool_use" | "refusal" | "content_filter" | "pause_turn";
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total: number } };
  durationMs: number; timestamp: number;
};
export type LlmResult = { gatewayJobId: string; response: LlmResponse };
export function parseLlmResponse(value: unknown): LlmResponse {
  const r = object(parseJsonValue(value));
  nonemptyString(r.id, "response.id"); nonemptyString(r.modelId, "response.modelId");
  optionalString(r, "resolvedModelId");
  if (message(r.message!).role !== "assistant") invalid("Expected an assistant response.");
  if (!["stop", "length", "tool_use", "refusal", "content_filter", "pause_turn"].includes(string(r.stopReason))) invalid("Invalid stop reason.");
  if (typeof r.durationMs !== "number" || r.durationMs < 0 || typeof r.timestamp !== "number" || r.timestamp < 0) invalid("Invalid response timing.");
  if (r.usage !== undefined) {
    const usage = object(r.usage);
    counts(usage);
    if (usage.cost !== undefined) {
      const cost = object(usage.cost); counts(cost);
      if (typeof cost.total !== "number" || cost.total < 0) invalid("Invalid usage cost total.");
    }
  }
  return r as LlmResponse;
}
function counts(value: JsonObject) {
  for (const name of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (value[name] !== undefined && (typeof value[name] !== "number" || value[name] < 0)) invalid("Invalid usage count/cost.");
  }
}
