import { MAX_OPERATION_INPUT_BYTES, PI_BASH_TOOL, parseJsonValue, utf8Bytes } from "@managed-agents/contracts";
import type { JsonValue, LlmAssistantMessage, LlmInput, LlmMessage } from "@managed-agents/contracts";
import { OPENAI_MODELS } from "./contracts.ts";
import type { MinimalBashConfig } from "./contracts.ts";
import type { Sql } from "./state.ts";
import { createInstructions } from "./instructions.ts";

export class HarnessFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export type ToolCall = { callId: string; arguments: string };
/** Read native items without rewriting the preserved assistant message. */
export function toolCalls(message: LlmAssistantMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const item of message.content) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string") throw new HarnessFailure("INVALID_LLM_RESPONSE", "Malformed native assistant item.");
    if (item.type === "function_call") {
      if (item.name !== "bash" || typeof item.call_id !== "string" || !item.call_id || item.call_id.length > 2048
        || ids.has(item.call_id) || typeof item.arguments !== "string"
        || (item.status !== undefined && item.status !== "completed")) throw new HarnessFailure("INVALID_TOOL_CALL", "Expected complete, uniquely identified bash function calls.");
      ids.add(item.call_id); calls.push({ callId: item.call_id, arguments: item.arguments });
    } else if (item.type !== "message" && item.type !== "reasoning") {
      throw new HarnessFailure("UNSUPPORTED_LLM_ITEM", `Unsupported assistant item type: ${item.type}.`);
    }
  }
  return calls;
}
export function buildLlmInput(sql: Sql, config: MinimalBashConfig, sessionId: string, appended: readonly LlmMessage[] = []): JsonValue {
  const messages: LlmMessage[] = [];
  let bytes = 0;
  // Scan the ordered transcript; context eligibility is a harness decision, not an indexed view.
  for (const row of sql.exec<{ message_json: string; in_context: number }>("SELECT message_json, in_context FROM minimal_bash_messages ORDER BY sequence")) {
    if (!row.in_context) continue;
    bytes += utf8Bytes(row.message_json);
    if (bytes > MAX_OPERATION_INPUT_BYTES) throw new HarnessFailure("OPERATION_INPUT_TOO_LARGE", "Conversation exceeds the 8 MiB operation input limit. Compaction is not implemented.");
    const message = JSON.parse(row.message_json) as LlmMessage;
    if (message.role === "custom") throw new Error("Harness lifecycle messages must not enter model context.");
    messages.push(message);
  }
  // Proposed messages are included before their owning transition commits.
  for (const message of appended) {
    if (message.role === "custom") throw new Error("Lifecycle messages must not enter model context.");
    messages.push(message);
  }
  const model = OPENAI_MODELS[config.modelId];
  const input = parseJsonValue({ previousJobId: null, accountId: config.accountId, modelId: config.modelId,
    instructions: createInstructions(config), messages, tools: [PI_BASH_TOOL], providerOptions: {
      store: false, reasoning: { effort: config.reasoning, summary: "auto" }, include: ["reasoning.encrypted_content"],
      prompt_cache_key: Array.from(sessionId).slice(0, 64).join(""), max_output_tokens: model.maxTokens,
      tool_choice: "auto", parallel_tool_calls: false,
    },
  } satisfies LlmInput);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_OPERATION_INPUT_BYTES) throw new HarnessFailure("OPERATION_INPUT_TOO_LARGE", "Conversation and request settings exceed the 8 MiB operation input limit.");
  return input;
}
