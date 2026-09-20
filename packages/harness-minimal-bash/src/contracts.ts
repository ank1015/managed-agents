import { ContractException, isAbsoluteMachinePath, parseEventBody, parseJsonValue, parseLlmMessage, parseUuid } from "@managed-agents/contracts";
import type { EventBody, JsonValue, LlmMessage } from "@managed-agents/contracts";

export const MINIMAL_BASH_IDENTITY = Object.freeze({ id: "minimal-bash", version: "v7" });
export const MINIMAL_BASH_ROUTE = "minimal-bash-v7";
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];
// Snapshot of ../llm-providers/packages/provider-openai/src/models.ts. No runtime cross-repo imports.
// All five levels verified against official OpenAI model pages, 2026-09-18.
export const OPENAI_MODELS = Object.freeze({
  "gpt-6-astra": Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000 }),
  "gpt-5.6-sol": Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000 }),
  "gpt-5.6-terra": Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000 }),
  "gpt-5.6-luna": Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000 }),
});
export interface MinimalBashConfig {
  provider: "openai";
  modelId: keyof typeof OPENAI_MODELS;
  accountId: string;
  reasoning: ReasoningLevel;
  machineId: string;
  cwd: string;
}
export type UserMessage = Extract<LlmMessage, { role: "user" }>;
export type MinimalBashInput =
  | { type: "minimal_bash.message"; payload: { message: UserMessage } }
  | { type: "minimal_bash.cancel"; payload: { runId: string } }
  | { type: "minimal_bash.resume"; payload: Record<string, never> };

function fields(value: unknown, keys: string[]): Record<string, JsonValue> {
  const json = parseJsonValue(value);
  if (!json || typeof json !== "object" || Array.isArray(json) || Object.keys(json).some(key => !keys.includes(key))) throw new Error("Unexpected fields or non-object value.");
  return json;
}
export function parseMinimalBashConfig(value: JsonValue): MinimalBashConfig {
  try {
    const c = fields(value, ["provider", "modelId", "accountId", "reasoning", "machineId", "cwd"]);
    if (c.provider !== "openai") throw new Error("provider must be openai.");
    if (typeof c.modelId !== "string" || !Object.hasOwn(OPENAI_MODELS, c.modelId)) throw new Error("modelId must belong to the OpenAI catalog.");
    const reasoning = c.reasoning ?? "medium";
    if (Object.hasOwn(c, "reasoning") && c.reasoning === null) throw new Error("reasoning cannot be null.");
    if (!REASONING_LEVELS.includes(reasoning as ReasoningLevel)) throw new Error("reasoning must be low, medium, high, xhigh or max.");
    if (typeof c.cwd !== "string" || !c.cwd || c.cwd.length > 8192 || !isAbsoluteMachinePath(c.cwd)) throw new Error("cwd must be an absolute machine path.");
    return { provider: "openai", modelId: c.modelId as MinimalBashConfig["modelId"],
      accountId: parseUuid(c.accountId), reasoning: reasoning as ReasoningLevel, machineId: parseUuid(c.machineId), cwd: c.cwd };
  } catch (error) { throw new ContractException("INVALID_CONFIG", error instanceof Error ? error.message : "Invalid minimal bash configuration."); }
}
export function parseMinimalBashInput(value: EventBody): MinimalBashInput {
  try {
    const event = parseEventBody(value);
    switch (event.type) {
      case "minimal_bash.message": {
        const p = fields(event.payload, ["message"]);
        const message = parseLlmMessage(p.message);
        if (message.role !== "user" || message.content.length === 0) throw new Error("Expected a nonempty user message content array.");
        break;
      }
      case "minimal_bash.cancel": {
        const p = fields(event.payload, ["runId"]);
        if (typeof p.runId !== "string" || !p.runId.trim() || p.runId.length > 2048) throw new Error("runId is required.");
        break;
      }
      case "minimal_bash.resume": fields(event.payload, []); break;
      default: throw new Error("Unsupported minimal bash input.");
    }
    return event as MinimalBashInput;
  } catch (error) { throw new ContractException("INVALID_INPUT", error instanceof Error ? error.message : "Invalid minimal bash input."); }
}
