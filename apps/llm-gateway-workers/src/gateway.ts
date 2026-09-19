import { assertJsonSize, MAX_OPERATION_OUTCOME_BYTES, parseJsonValue, parseLlmResponse, parseUuid } from "@managed-agents/contracts";
import type { JsonValue, LlmInput, OperationOutcome } from "@managed-agents/contracts";
import type { Env } from "./types.ts";

export type JobStatus = "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "cancelled";
export interface Job { id: string; status: JobStatus; idempotencyKey: string }
const statuses = ["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"];
export const terminal = (status: JobStatus) => ["succeeded", "failed", "cancelled"].includes(status);
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Gateway request failed (${status}, ${code}).`); }
}
export class BodyTooLarge extends Error {}
/** Bounds memory before JSON parsing; also used for the small public webhook body. */
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
      if (size > maximum) { await reader.cancel(); throw new BodyTooLarge("Response exceeds inline transfer limit."); }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { reader.releaseLock(); }
}
function object(value: unknown): Record<string, JsonValue> {
  const json = parseJsonValue(value);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid gateway response.");
  return json;
}
function job(value: unknown): Job {
  const row = object(value);
  if (typeof row.status !== "string" || !statuses.includes(row.status) || typeof row.idempotencyKey !== "string") throw new Error("Invalid gateway job.");
  return { id: parseUuid(row.id), status: row.status as JobStatus, idempotencyKey: row.idempotencyKey };
}
export class Gateway {
  readonly base: string;
  constructor(readonly env: Env) {
    const url = new URL(env.GATEWAY_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("GATEWAY_URL must be an HTTPS origin.");
    }
    if (!env.GATEWAY_API_KEY?.trim()) throw new Error("Gateway credential is not configured.");
    this.base = url.origin;
  }
  async request(path: string, body?: JsonValue, maximum = 64 * 1024): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(`${this.base}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "manual", signal: controller.signal,
        headers: { Authorization: `Bearer ${this.env.GATEWAY_API_KEY}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await readLimited(response.body, response.ok ? maximum : 16 * 1024);
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error("Gateway returned invalid JSON."); }
      if (!response.ok) {
        const error = object(value).error;
        const code = error && typeof error === "object" && !Array.isArray(error) ? error.code : undefined;
        throw new GatewayError(response.status, typeof code === "string" && /^[a-z_]{1,100}$/.test(code) ? code : "http_error");
      }
      return value;
    } catch (error) {
      if (error instanceof GatewayError || error instanceof BodyTooLarge) throw error;
      throw new Error("Gateway request unavailable or returned an invalid response.");
    } finally { clearTimeout(timer); }
  }
  async submit(input: LlmInput, key: string): Promise<{ id: string; status: JobStatus }> {
    const result = object(await this.request("/v1/jobs", { ...input, idempotencyKey: key }));
    if (typeof result.status !== "string" || !statuses.includes(result.status)) throw new Error("Invalid gateway acceptance.");
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
    // Retained request (up to 16 MiB) plus an 8 MiB response and envelope headroom.
    const body = object(await this.request(`/v1/jobs/${encodeURIComponent(id)}`, undefined, 32 * 1024 * 1024));
    const metadata = job(body);
    if (metadata.id !== id) throw new Error("Gateway returned a different job.");
    return { metadata, body };
  }
  async outcome(expected: Pick<Job, "id" | "idempotencyKey">): Promise<OperationOutcome> {
    try {
      return this.outcomeFromDetail(expected, await this.detail(expected.id));
    } catch (error) {
      if (error instanceof BodyTooLarge) return tooLarge(expected.id);
      throw error;
    }
  }
  outcomeFromDetail(expected: Pick<Job, "id" | "idempotencyKey">,
    detail: { metadata: Job; body: Record<string, JsonValue> }): OperationOutcome {
    const { metadata, body } = detail;
    if (metadata.id !== expected.id || metadata.idempotencyKey !== expected.idempotencyKey) throw new Error("Gateway terminal job changed.");
    if (metadata.status === "cancelled") return { status: "cancelled" };
    if (metadata.status === "failed") {
      const error = object(body.error);
      if (typeof error.code !== "string" || typeof error.message !== "string") throw new Error("Invalid gateway job error.");
      return { status: "failed", origin: "execution", error: {
        code: error.code.slice(0, 200), message: error.message.slice(0, 1000), details: { gatewayJobId: expected.id },
      } };
    }
    if (metadata.status !== "succeeded") throw new Error("Gateway job is not terminal.");
    const result = { gatewayJobId: expected.id, response: parseLlmResponse(body.response) };
    try { assertJsonSize({ status: "succeeded", result }, MAX_OPERATION_OUTCOME_BYTES); }
    catch { return tooLarge(expected.id); }
    return { status: "succeeded", result };
  }
}
function tooLarge(jobId: string): OperationOutcome {
  return { status: "failed", origin: "execution", error: { code: "LLM_RESULT_TOO_LARGE",
    message: "The gateway result exceeds inline delivery limits; the original remains available in the gateway.",
    details: { gatewayJobId: jobId } } };
}
/** These gateway errors definitively precede job acceptance. Auth/conflicts/infrastructure remain errors. */
export function submissionRejected(error: unknown): error is GatewayError {
  return error instanceof GatewayError && [400, 404, 409, 410, 413, 415].includes(error.status)
    && ["invalid_request", "invalid_model", "not_found", "account_disabled", "previous_job_not_succeeded",
      "previous_request_expired", "request_too_large", "destination_not_allowed", "unsupported_media_type"].includes(error.code);
}
