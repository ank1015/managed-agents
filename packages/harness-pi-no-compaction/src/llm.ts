import { MAX_OPERATION_INPUT_BYTES, parseJsonValue, utf8Bytes } from "@managed-agents/contracts";
import type { JsonValue, LlmAssistantMessage, LlmInput, LlmMessage } from "@managed-agents/contracts";
import type { PiNoCompactionConfig } from "./contracts.ts";
import type { Sql } from "./state.ts";
import { createInstructions } from "./instructions.ts";
import { TOOLS, isToolName } from "./tools.ts";
import type { ToolCall } from "./tools.ts";

export class HarnessFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessFailure("INVALID_LLM_RESPONSE", "Malformed native assistant item.");
  return value;
}
/** Inspect native calls without rewriting provider-native replay content. */
export function toolCalls(message: LlmAssistantMessage): ToolCall[] {
  const calls: ToolCall[] = [], ids = new Set<string>();
  function add(id: unknown, name: unknown, args: unknown) {
    if (typeof id !== "string" || !id.trim() || id.length > 2048 || ids.has(id) || !isToolName(name) || typeof args !== "string") {
      throw new HarnessFailure("INVALID_TOOL_CALL", "Expected uniquely identified calls to read, bash, edit or write with JSON argument strings.");
    }
    ids.add(id); calls.push({ callId: id, name, arguments: args });
  }
  if (message.provider === "openai") {
    for (const raw of message.content) {
      const item = object(raw);
      if (item.type === "function_call") {
        if (item.status !== undefined && item.status !== "completed") throw new HarnessFailure("INVALID_TOOL_CALL", "Incomplete function call.");
        add(item.call_id, item.name, item.arguments);
      } else if (item.type !== "message" && item.type !== "reasoning") {
        throw new HarnessFailure("UNSUPPORTED_LLM_ITEM", "Unsupported OpenAI assistant item.");
      }
    }
  } else if (message.provider === "fireworks") {
    if (message.content.length !== 1) throw new HarnessFailure("INVALID_LLM_RESPONSE", "Expected one native Fireworks assistant message.");
    const item = object(message.content[0]);
    if (item.role !== "assistant" || (item.content !== undefined && item.content !== null && typeof item.content !== "string")
      || (item.reasoning_content !== undefined && item.reasoning_content !== null && typeof item.reasoning_content !== "string")
      || item.function_call != null) throw new HarnessFailure("INVALID_LLM_RESPONSE", "Malformed or legacy Fireworks assistant message.");
    if (item.tool_calls !== undefined && item.tool_calls !== null) {
      if (!Array.isArray(item.tool_calls)) throw new HarnessFailure("INVALID_TOOL_CALL", "Malformed Fireworks tool calls.");
      for (const raw of item.tool_calls) {
        const call = object(raw), fn = object(call.function);
        if (call.type !== "function") throw new HarnessFailure("INVALID_TOOL_CALL", "Unsupported Fireworks tool type.");
        add(call.id, fn.name, fn.arguments);
      }
    }
  } else throw new HarnessFailure("LLM_MODEL_MISMATCH", "Unsupported assistant provider.");
  return calls;
}
export function buildLlmInput(sql: Sql, config: PiNoCompactionConfig, sessionId: string, appended: readonly LlmMessage[] = []): JsonValue {
  const messages: LlmMessage[] = [];
  let bytes = 0;
  // Scan the ordered transcript; context eligibility is a harness decision, not an indexed view.
  for (const row of sql.exec<{ message_json: string; in_context: number }>("SELECT message_json, in_context FROM pi_no_compaction_messages ORDER BY sequence")) {
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
  const input = parseJsonValue({ previousJobId: null, accountId: config.accountId, modelId: config.modelId,
    instructions: createInstructions(config), messages, tools: TOOLS, providerOptions: config.provider === "openai" ? {
      store: false, reasoning: { effort: config.reasoning, summary: "auto" }, include: ["reasoning.encrypted_content"],
      prompt_cache_key: Array.from(sessionId).slice(0, 64).join(""), max_output_tokens: config.maxOutputTokens,
      tool_choice: "auto", parallel_tool_calls: true,
    } : {
      reasoning_effort: config.reasoning, max_tokens: config.maxOutputTokens,
      prompt_cache_key: Array.from(sessionId).slice(0, 64).join(""), tool_choice: "auto", parallel_tool_calls: true,
      context_length_exceeded_behavior: "error",
    },
  } satisfies LlmInput);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_OPERATION_INPUT_BYTES) throw new HarnessFailure("OPERATION_INPUT_TOO_LARGE", "Conversation and request settings exceed the 8 MiB operation input limit.");
  return input;
}
