import { assertJsonSize, MAX_OPERATION_OUTCOME_BYTES, parseJsonValue, parseLlmResponse, parseUuid } from "@managed-agents/contracts";
import type { JsonValue, LlmInput, OperationOutcome } from "@managed-agents/contracts";
import type { Env } from "./types.ts";
import { parseClientContext, sameContext } from "./context.ts";
import type { ClientContext } from "./context.ts";

export type JobStatus = "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "cancelled";
export interface Job { id: string; status: JobStatus; idempotencyKey: string; clientContext: ClientContext }
type ExpectedJob = Omit<Job, "status"> & { status?: JobStatus };
const statuses = ["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"];
export const terminal = (status: JobStatus) => ["succeeded", "failed", "cancelled"].includes(status);
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`Gateway request failed (${status}, ${code}).`);
    this.status = status;
    this.code = code;
  }
}
export class BodyTooLarge extends Error {}
/** Bounds memory before JSON parsing for gateway responses and inline callbacks. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, maximum: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!body) return "";
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new BodyTooLarge("Response exceeds inline transfer limit."); }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
}
function object(value: unknown): Record<string, JsonValue> {
  const json = parseJsonValue(value);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid gateway response.");
  return json;
}
function job(row: Record<string, JsonValue>): Job {
  if (typeof row.status !== "string" || !statuses.includes(row.status) || typeof row.idempotencyKey !== "string") throw new Error("Invalid gateway job.");
  return { id: parseUuid(row.id), status: row.status as JobStatus, idempotencyKey: row.idempotencyKey,
    clientContext: parseClientContext(row.clientContext) };
}
export class Gateway {
  readonly base: string;
  readonly env: Env;
  readonly signal: AbortSignal | undefined;
  constructor(env: Env, signal?: AbortSignal) {
    const url = new URL(env.GATEWAY_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("GATEWAY_URL must be an HTTPS origin.");
    }
    if (!env.GATEWAY_API_KEY?.trim()) throw new Error("Gateway credential is not configured.");
    this.env = env;
    this.signal = signal;
    this.base = url.origin;
  }
  async request(path: string, body?: JsonValue, maximum = 64 * 1024): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      const response = await fetch(`${this.base}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "manual", signal,
        headers: { Authorization: `Bearer ${this.env.GATEWAY_API_KEY}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let text: string;
      try { text = await readLimited(response.body, response.ok ? maximum : 16 * 1024, signal); }
      catch (error) {
        // An oversized proxy/auth/error page is not an oversized successful model result.
        if (error instanceof BodyTooLarge && !response.ok) throw new Error("Gateway error response exceeds its transport limit.");
        throw error;
      }
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
  async submit(input: LlmInput, key: string, clientContext: ClientContext): Promise<{ id: string; status: JobStatus }> {
    const result = object(await this.request("/v1/jobs", { ...input, idempotencyKey: key, clientContext }));
    if (typeof result.status !== "string" || !statuses.includes(result.status)) throw new Error("Invalid gateway acceptance.");
    return { id: parseUuid(result.id), status: result.status as JobStatus };
  }
  async detail(id: string): Promise<{ metadata: Job; body: Record<string, JsonValue> }> {
    // The gateway retains its own request/response; reject oversized outcomes after reading detail.
    const body = object(await this.request(`/v1/jobs/${encodeURIComponent(id)}`, undefined, 32 * 1024 * 1024));
    const metadata = job(body);
    if (metadata.id !== id) throw new Error("Gateway returned a different job.");
    return { metadata, body };
  }
  async outcome(expected: ExpectedJob): Promise<OperationOutcome> {
    try {
      return this.outcomeFromDetail(expected, await this.detail(expected.id));
    } catch (error) {
      if (error instanceof BodyTooLarge) return tooLarge(expected.id);
      throw error;
    }
  }
  outcomeFromDetail(expected: ExpectedJob,
    detail: { metadata: Job; body: Record<string, JsonValue> }): OperationOutcome {
    const { metadata, body } = detail;
    if (metadata.id !== expected.id || metadata.idempotencyKey !== expected.idempotencyKey
      || !sameContext(metadata.clientContext, expected.clientContext)
      || (expected.status !== undefined && metadata.status !== expected.status)) throw new Error("Gateway terminal job changed.");
    return terminalOutcome(expected.id, metadata.status, body.response, body.error);
  }
}

/** Shared normalization for signed inline callbacks and terminal submission replay. */
export function terminalOutcome(jobId: string, status: JobStatus, response: unknown, failure: unknown): OperationOutcome {
  if (status === "cancelled") {
    if (response !== null || failure !== null) throw new Error("Invalid cancelled outcome.");
    return { status: "cancelled" };
  }
  if (status === "failed") {
    if (response !== null) throw new Error("Invalid failed outcome.");
    const error = object(failure);
    if (typeof error.code !== "string" || typeof error.message !== "string") throw new Error("Invalid gateway job error.");
    return { status: "failed", origin: "execution", error: {
      code: error.code.slice(0, 200), message: error.message.slice(0, 1000), details: { gatewayJobId: jobId },
    } };
  }
  if (status !== "succeeded" || failure !== null) throw new Error("Invalid successful terminal outcome.");
  const result = { gatewayJobId: jobId, response: parseLlmResponse(response) };
  try { assertJsonSize({ status: "succeeded", result }, MAX_OPERATION_OUTCOME_BYTES); }
  catch { return tooLarge(jobId); }
  return { status: "succeeded", result };
}
function tooLarge(jobId: string): OperationOutcome {
  return { status: "failed", origin: "execution", error: { code: "LLM_RESULT_TOO_LARGE",
    message: `The gateway result exceeds the ${MAX_OPERATION_OUTCOME_BYTES}-byte inline delivery limit; the original remains available in the gateway.`,
    details: { gatewayJobId: jobId } } };
}
/** These gateway errors definitively precede job acceptance. Auth/conflicts/infrastructure remain errors. */
export function submissionRejected(error: unknown): error is GatewayError {
  return error instanceof GatewayError && [400, 404, 409, 410, 413, 415].includes(error.status)
    && ["invalid_request", "invalid_model", "not_found", "account_disabled", "previous_job_not_succeeded",
      "previous_request_expired", "request_too_large", "destination_not_allowed", "unsupported_media_type"].includes(error.code);
}
