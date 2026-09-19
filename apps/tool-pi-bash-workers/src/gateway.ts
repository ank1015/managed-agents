import { BASH_GATEWAY_PREVIEW_BYTES, PI_BASH_RECEIVER, bashTimeoutMs, parseOperationOutcome, parseUuid } from "@managed-agents/contracts";
import type { BashInput, JsonValue, OperationOutcome } from "@managed-agents/contracts";
import { formatRun, object } from "./result.ts";
import type { Env } from "./types.ts";

export type JobStatus = "queued" | "dispatching" | "waiting_response" | "succeeded" | "failed" | "unknown";
export interface Job { id: string; status: JobStatus; idempotencyKey: string; machineId: string; runtimeGenerationId: string | null }
// Stored correlation is always required; polling can additionally supply observed terminal metadata.
type ExpectedJob = Pick<Job, "id" | "idempotencyKey" | "machineId"> & Partial<Pick<Job, "status" | "runtimeGenerationId">>;
const statuses = ["queued", "dispatching", "waiting_response", "succeeded", "failed", "unknown"];
export const terminal = (status: JobStatus) => ["succeeded", "failed", "unknown"].includes(status);
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Execution gateway request failed (${status}, ${code}).`); }
}
export class BodyTooLarge extends Error {}
export async function readLimited(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new BodyTooLarge("Gateway response exceeds transfer limit."); }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { reader.releaseLock(); }
}
function job(value: unknown): Job {
  const r = object(value);
  if (typeof r.status !== "string" || !statuses.includes(r.status) || typeof r.idempotencyKey !== "string") throw new Error("Invalid gateway job.");
  return { id: parseUuid(r.id), status: r.status as JobStatus, idempotencyKey: r.idempotencyKey,
    machineId: parseUuid(r.machineId), runtimeGenerationId: r.runtimeGenerationId === null ? null : parseUuid(r.runtimeGenerationId) };
}
function failure(jobId: string, code: string, message: string, details: Record<string, JsonValue> = {}): OperationOutcome {
  return { status: "failed", origin: "execution", error: { code, message, details: { gatewayJobId: jobId, ...details } } };
}
export class Gateway {
  readonly base: string;
  constructor(readonly env: Env) {
    const url = new URL(env.EXECUTION_GATEWAY_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("EXECUTION_GATEWAY_URL must be an HTTPS origin.");
    if (!env.EXECUTION_GATEWAY_API_KEY?.trim()) throw new Error("Execution gateway credential is not configured.");
    this.base = url.origin;
  }
  async request(path: string, body?: JsonValue, maximum = 64 * 1024): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(`${this.base}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "manual", signal: controller.signal,
        headers: { Authorization: `Bearer ${this.env.EXECUTION_GATEWAY_API_KEY}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await readLimited(response.body, response.ok ? maximum : 16 * 1024);
      const value: unknown = JSON.parse(text);
      if (!response.ok) {
        const error = object(value).error;
        const code = error && typeof error === "object" && !Array.isArray(error) ? error.code : undefined;
        throw new GatewayError(response.status, typeof code === "string" && /^[a-z_]{1,100}$/.test(code) ? code : "http_error");
      }
      return value;
    } catch (error) {
      if (error instanceof GatewayError || error instanceof BodyTooLarge) throw error;
      throw new Error("Execution gateway unavailable or returned an invalid response.");
    } finally { clearTimeout(timer); }
  }
  async submit(input: BashInput, key: string, submissionId: string): Promise<{ id: string; status: JobStatus }> {
    const result = object(await this.request("/v1/jobs", {
      machineId: input.machineId, idempotencyKey: key,
      clientContext: { receiver: PI_BASH_RECEIVER, reference: submissionId },
      request: { operation: "execution.run", params: {
        run_id: key, cwd: input.cwd, max_output_bytes: BASH_GATEWAY_PREVIEW_BYTES,
        command: { type: "shell", script: input.command, shell: { executable: "bash", kind: "bash" }, login: false },
        ...(input.timeout === undefined ? {} : { timeout_ms: bashTimeoutMs(input.timeout) }),
      } },
    }));
    if (typeof result.status !== "string" || !statuses.includes(result.status)) throw new Error("Invalid execution gateway acceptance.");
    return { id: parseUuid(result.id), status: result.status as JobStatus };
  }
  async lookup(key: string): Promise<Job | null> {
    const result = object(await this.request(`/v1/jobs?idempotencyKey=${encodeURIComponent(key)}&limit=2`));
    if (!Array.isArray(result.data) || result.data.length > 1 || result.nextCursor !== null) throw new Error("Invalid gateway job lookup.");
    if (!result.data.length) return null;
    const found = job(result.data[0]);
    if (found.idempotencyKey !== key) throw new Error("Gateway returned a different submission.");
    return found;
  }
  async detail(id: string): Promise<{ metadata: Job; body: Record<string, JsonValue> }> {
    // Upstream detail includes both retained request and response (each bounded near 8 MiB).
    const body = object(await this.request(`/v1/jobs/${encodeURIComponent(id)}`, undefined, 18 * 1024 * 1024));
    const metadata = job(body);
    if (metadata.id !== id) throw new Error("Gateway returned a different job.");
    return { metadata, body };
  }
  async outcome(expected: ExpectedJob, timeout: number | null): Promise<OperationOutcome> {
    const { metadata, body } = await this.detail(expected.id);
    if (metadata.idempotencyKey !== expected.idempotencyKey || metadata.machineId !== expected.machineId
      || (expected.status !== undefined && metadata.status !== expected.status)
      || (expected.runtimeGenerationId !== undefined && metadata.runtimeGenerationId !== expected.runtimeGenerationId)) {
      throw new Error("Gateway terminal job changed or conflicts with retained correlation.");
    }
    if (!terminal(metadata.status)) throw new Error("Gateway job is not terminal despite its completion notification.");
    if (metadata.status === "unknown") return failure(metadata.id, "BASH_EXECUTION_UNKNOWN", "Command may have run, but its outcome is unknown. Do not automatically execute it again.");
    if (body.error !== null) {
      if (metadata.status !== "failed") throw new Error("Gateway error conflicts with job status.");
      const error = object(body.error);
      if (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) throw new Error("Invalid gateway job error.");
      return failure(metadata.id, error.code.slice(0, 200), error.message.slice(0, 1000));
    }
    const response = object(body.response);
    if (response.protocol_version !== 4 || response.request_id !== metadata.id || response.generation_id !== metadata.runtimeGenerationId) throw new Error("Invalid execution response correlation/version.");
    if (response.status === "error" && metadata.status === "failed") {
      const error = object(response.error);
      if (typeof error.code !== "string" || !error.code || typeof error.message !== "string" || !error.message) throw new Error("Invalid operation error.");
      return failure(metadata.id, error.code.slice(0, 200), error.message.slice(0, 1000));
    }
    if (response.status !== "ok" || metadata.status !== "succeeded" || !metadata.runtimeGenerationId) throw new Error("Invalid terminal execution response.");
    const result = formatRun(response.result, { jobId: metadata.id, machineId: metadata.machineId,
      runId: metadata.idempotencyKey, generationId: metadata.runtimeGenerationId }, timeout);
    if (result.details.reason === "lost") return failure(metadata.id, "BASH_EXECUTION_UNKNOWN", "Command outcome was lost; do not automatically execute it again.", { toolResult: result });
    return parseOperationOutcome({ status: "succeeded", result });
  }
}
/** Only definitive admission errors reject. Offline/capacity/auth/transport errors keep the same identity. */
export function submissionRejected(error: unknown): error is GatewayError {
  return error instanceof GatewayError && [400, 404, 409, 413, 415].includes(error.status)
    && ["invalid_argument", "not_found", "machine_disabled", "payload_too_large", "unsupported_media_type"].includes(error.code);
}
