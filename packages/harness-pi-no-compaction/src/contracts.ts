import { ContractException, parseExecutionGatewayUrl, parseExecutionToken, isAbsoluteMachinePath, parseEventBody, parseJsonValue, parseLlmMessage, parseUuid, utf8Bytes } from "@managed-agents/contracts";
import type { EventBody, JsonValue, LlmMessage } from "@managed-agents/contracts";

export const PI_NO_COMPACTION_IDENTITY = Object.freeze({ id: "pi-no-compaction", version: "v1" });
export const PI_NO_COMPACTION_ROUTE = "pi-no-compaction-v1";
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];
// Explicit snapshots of ../llm-providers catalogs. Only vision-capable models are admitted.
export const OPENAI_MODELS = Object.freeze({
  "gpt-6-astra": { maxTokens: 128_000 }, "gpt-5.6-sol": { maxTokens: 128_000 },
  "gpt-5.6-terra": { maxTokens: 128_000 }, "gpt-5.6-luna": { maxTokens: 128_000 },
});
export const FIREWORKS_MODELS = Object.freeze({
  "accounts/fireworks/models/glm-5p3-flash": { maxTokens: 1_048_576 },
  "accounts/fireworks/models/kimi-k3": { maxTokens: 1_048_576 },
  "accounts/fireworks/models/deepseek-v4p1-flash": { maxTokens: 393_216 },
});
type CommonConfig = { accountId: string; reasoning: ReasoningLevel; machineId: string; executionGatewayUrl: string; executionToken: string; cwd: string; maxOutputTokens: number };
export type PiNoCompactionConfig = CommonConfig & (
  | { provider: "openai"; modelId: keyof typeof OPENAI_MODELS }
  | { provider: "fireworks"; modelId: keyof typeof FIREWORKS_MODELS }
);
export type UserMessage = Extract<LlmMessage, { role: "user" }>;
export type PiNoCompactionInput =
  | { type: "pi_no_compaction.message"; payload: { message: UserMessage } }
  | { type: "pi_no_compaction.cancel"; payload: { runId: string } }
  | { type: "pi_no_compaction.resume"; payload: Record<string, never> };

function fields(value: unknown, keys: string[]): Record<string, JsonValue> {
  const json = parseJsonValue(value);
  if (!json || typeof json !== "object" || Array.isArray(json) || Object.keys(json).some(key => !keys.includes(key))) throw new Error("Unexpected fields or non-object value.");
  return json;
}
export function parsePiNoCompactionConfig(value: JsonValue): PiNoCompactionConfig {
  try {
    const c = fields(value, ["provider", "modelId", "accountId", "reasoning", "machineId", "executionGatewayUrl", "executionToken", "cwd", "maxOutputTokens"]);
    if (c.provider !== "openai" && c.provider !== "fireworks") throw new Error("provider must be openai or fireworks.");
    const catalog = c.provider === "openai" ? OPENAI_MODELS : FIREWORKS_MODELS;
    if (typeof c.modelId !== "string" || !Object.hasOwn(catalog, c.modelId)) throw new Error("modelId must belong to the selected provider's vision-capable catalog.");
    const reasoning = c.reasoning === undefined ? "medium" : c.reasoning;
    if (!REASONING_LEVELS.includes(reasoning as ReasoningLevel)) throw new Error("reasoning must be low, medium, high, xhigh or max.");
    if (typeof c.cwd !== "string" || !c.cwd || c.cwd.length > 8192 || !isAbsoluteMachinePath(c.cwd)) throw new Error("cwd must be an absolute machine path.");
    const max = (catalog as Record<string, { maxTokens: number }>)[c.modelId]!.maxTokens;
    const maxOutputTokens = c.maxOutputTokens === undefined ? (c.provider === "openai" ? 128_000 : 32_768) : c.maxOutputTokens;
    if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > max) throw new Error(`maxOutputTokens must be an integer between 1 and ${max}.`);
    const machineId = parseUuid(c.machineId), executionToken = parseExecutionToken(c.executionToken);
    if (executionToken.split(".")[1] !== machineId) throw new Error("executionToken must belong to machineId.");
    return { provider: c.provider, modelId: c.modelId, accountId: parseUuid(c.accountId), reasoning: reasoning as ReasoningLevel,
      machineId, executionToken, executionGatewayUrl: parseExecutionGatewayUrl(c.executionGatewayUrl), cwd: c.cwd, maxOutputTokens } as PiNoCompactionConfig;
  } catch (error) { throw new ContractException("INVALID_CONFIG", error instanceof Error ? error.message : "Invalid Pi configuration."); }
}
export function parsePiNoCompactionInput(value: EventBody): PiNoCompactionInput {
  try {
    const event = parseEventBody(value);
    // Bound user messages before durable admission, including direct trusted-host callers.
    // Leaves room for transcript correlation fields and future run IDs.
    if (utf8Bytes(JSON.stringify(event)) > 1_800_000) throw new Error("Input exceeds the 1,800,000-byte harness input limit.");
    switch (event.type) {
      case "pi_no_compaction.message": {
        const p = fields(event.payload, ["message"]);
        const message = parseLlmMessage(p.message);
        if (message.role !== "user" || message.content.length === 0) throw new Error("Expected a nonempty user message content array.");
        break;
      }
      case "pi_no_compaction.cancel": {
        const p = fields(event.payload, ["runId"]);
        if (typeof p.runId !== "string" || !p.runId.trim() || p.runId.length > 2048) throw new Error("runId is required.");
        break;
      }
      case "pi_no_compaction.resume": fields(event.payload, []); break;
      default: throw new Error("Unsupported Pi input.");
    }
    return event as PiNoCompactionInput;
  } catch (error) { throw new ContractException("INVALID_INPUT", error instanceof Error ? error.message : "Invalid Pi input."); }
}
