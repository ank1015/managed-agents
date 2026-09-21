import { parseToolExecutionSubmission } from "./tool-execution.ts";
import type { ToolExecutionSubmission } from "./tool-execution.ts";
import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import { parseUuid } from "./llm.ts";
import type { LlmTool } from "./llm.ts";
import { nonemptyString, record } from "./validation.ts";

export const PI_BASH_OPERATION = Object.freeze({ provider: "tool-pi-bash", type: "bash", version: "v1" });
export const PI_BASH_RECEIVER = "tool-pi-bash-v1";
export const PI_BASH_MAX_LINES = 2000;
export const PI_BASH_MAX_BYTES = 50 * 1024;
export const BASH_GATEWAY_PREVIEW_BYTES = 64 * 1024;
export const PI_BASH_MAX_TIMEOUT_MS = 2_147_483_647;
/** Model-facing definition. The harness adds machine/cwd; neither is model-selectable. */
export const PI_BASH_TOOL = Object.freeze({
  type: "function", name: "bash",
  description: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
  parameters: {
    type: "object", properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
    }, required: ["command"], additionalProperties: false,
  },
} satisfies LlmTool);

export type BashToolInput = { command: string; timeout?: number };
export type BashInput = BashToolInput & { machineId: string; cwd: string };
export type BashSubmission = ToolExecutionSubmission;
export interface BashWorkerBinding { submit(value: unknown): Promise<unknown> }

export function parseBashToolInput(value: unknown): BashToolInput {
  const r = record(parseJsonValue(value), ["command", "timeout"], "bash arguments");
  if (typeof r.command !== "string" || r.command.includes("\0")) throw new ContractException("INVALID_REQUEST", "command must be a string without NUL bytes.");
  if (r.timeout !== undefined && (typeof r.timeout !== "number" || r.timeout <= 0 || r.timeout * 1000 > PI_BASH_MAX_TIMEOUT_MS)) {
    throw new ContractException("INVALID_REQUEST", `timeout must be positive and at most ${PI_BASH_MAX_TIMEOUT_MS / 1000} seconds.`);
  }
  return { command: r.command, ...(r.timeout === undefined ? {} : { timeout: r.timeout as number }) };
}
/** Absolute POSIX, drive-rooted Windows, or UNC path; no local filesystem inspection. */
export function isAbsoluteMachinePath(value: string): boolean {
  return !value.includes("\0") && (value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}
export function parseBashInput(value: unknown): BashInput {
  const r = record(parseJsonValue(value), ["machineId", "cwd", "command", "timeout"], "bash input");
  const cwd = nonemptyString(r.cwd, "cwd");
  if (!isAbsoluteMachinePath(cwd) || cwd.length > 8192) throw new ContractException("INVALID_REQUEST", "cwd must be an absolute machine path of at most 8192 characters.");
  return { machineId: parseUuid(r.machineId), cwd,
    ...parseBashToolInput({ command: r.command!, ...(r.timeout === undefined ? {} : { timeout: r.timeout }) }) };
}
/** Node/Pi timers truncate fractional milliseconds and clamp sub-millisecond values to 1 ms. */
export function bashTimeoutMs(timeout: number): number { return Math.max(1, Math.trunc(timeout * 1000)); }
export const parseBashSubmission = parseToolExecutionSubmission;

export type BashResult = {
  content: { type: "text"; text: string }[];
  /** A known command failure is a completed tool invocation, not a reason to execute it again. */
  isError: boolean;
  details: {
    requestId: string; machineId: string; runtimeGeneration: string;
    wallTimeSeconds: number; originalBytes: number;
    reason: "exited" | "timed_out" | "terminated" | "start_failed" | "lost";
    exitCode: number | null; signal: string | null; timedOut: boolean;
    fullOutputPath: string;
    outputFile: { artifactId: string; sizeBytes: number; complete: boolean; expiresAt: string | null };
    truncation: {
      truncated: boolean; truncatedBy: "lines" | "bytes" | "upstream" | null;
      outputLines: number; outputBytes: number; maxLines: number; maxBytes: number;
      /** Unknown when the upstream tail omits the beginning. Never invent full-file text counts. */
      totalLines: number | null; totalTextBytes: number | null;
      upstreamTruncated: boolean; lastLinePartial: boolean;
    };
  };
};
