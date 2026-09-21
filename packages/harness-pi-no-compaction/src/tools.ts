import { PI_BASH_TOOL, PI_READ_TOOL, PI_EDIT_TOOL, PI_WRITE_TOOL, PI_BASH_OPERATION, PI_READ_OPERATION,
  PI_EDIT_OPERATION, PI_WRITE_OPERATION, parseBashToolInput, parseReadToolInput, parseEditToolInput, parseWriteToolInput,
  parseOperationRequest } from "@managed-agents/contracts";
import type { PiNoCompactionConfig } from "./contracts.ts";

export const TOOLS = [PI_READ_TOOL, PI_BASH_TOOL, PI_EDIT_TOOL, PI_WRITE_TOOL];
export const TOOL_OPERATIONS = [PI_BASH_OPERATION, PI_READ_OPERATION, PI_EDIT_OPERATION, PI_WRITE_OPERATION];
export type ToolName = "bash" | "read" | "edit" | "write";
export type ToolCall = { callId: string; name: ToolName; arguments: string };
export function isToolName(name: unknown): name is ToolName { return name === "bash" || name === "read" || name === "edit" || name === "write"; }
export function isMutation(name: ToolName): boolean { return name === "edit" || name === "write"; }
export function toolRequest(call: ToolCall, config: PiNoCompactionConfig) {
  const value: unknown = JSON.parse(call.arguments);
  const tool = {
    bash: { operation: PI_BASH_OPERATION, parse: parseBashToolInput },
    read: { operation: PI_READ_OPERATION, parse: parseReadToolInput },
    edit: { operation: PI_EDIT_OPERATION, parse: parseEditToolInput },
    write: { operation: PI_WRITE_OPERATION, parse: parseWriteToolInput },
  }[call.name];
  return parseOperationRequest({ ...tool.operation, input: { ...tool.parse(value), machineId: config.machineId, cwd: config.cwd } });
}
