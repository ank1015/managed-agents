import { jsonEquals, parseUuid, PI_READ_MAX_FILE_BYTES } from "@managed-agents/contracts";
import type { ReadInput, JsonValue, OperationOutcome } from "@managed-agents/contracts";
import { parseReadContext } from "./context.ts";
import type { ReadContext } from "./context.ts";
import { readLimited, BodyTooLarge } from "./http.ts";
import { object } from "./result.ts";
import { terminalOutcome } from "./outcome.ts";
import type { Env } from "./types.ts";

export type JobStatus = "queued" | "dispatching" | "waiting_response" | "succeeded" | "failed" | "unknown";
export interface Job { id: string; status: JobStatus; idempotencyKey: string; machineId: string; runtimeGenerationId: string | null; clientContext: ReadContext }
type ExpectedJob = Pick<Job, "id" | "idempotencyKey" | "machineId" | "clientContext"> & Partial<Pick<Job, "status" | "runtimeGenerationId">>;
const statuses = ["queued", "dispatching", "waiting_response", "succeeded", "failed", "unknown"];
export const terminal = (status: JobStatus) => ["succeeded", "failed", "unknown"].includes(status);
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Execution gateway request failed (${status}, ${code}).`); }
}
function job(value: unknown): Job {
  const r = object(value);
  if (typeof r.status !== "string" || !statuses.includes(r.status) || typeof r.idempotencyKey !== "string") throw new Error("Invalid execution gateway job.");
  return { clientContext: parseReadContext(r.clientContext), id: parseUuid(r.id), status: r.status as JobStatus,
    idempotencyKey: r.idempotencyKey, machineId: parseUuid(r.machineId), runtimeGenerationId: r.runtimeGenerationId === null ? null : parseUuid(r.runtimeGenerationId) };
}
export class Gateway {
  readonly base: string;
  constructor(readonly env: Env, readonly signal: AbortSignal) {
    const url = new URL(env.EXECUTION_GATEWAY_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("EXECUTION_GATEWAY_URL must be an HTTPS origin.");
    if (!env.EXECUTION_GATEWAY_API_KEY?.trim()) throw new Error("Execution gateway credential is not configured.");
    this.base = url.origin;
  }
  async request(path: string, body?: JsonValue, maximum = 64 * 1024): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 7000);
    const signal = AbortSignal.any([this.signal, controller.signal]);
    try {
      signal.throwIfAborted();
      const response = await fetch(`${this.base}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "manual", signal,
        headers: { Authorization: `Bearer ${this.env.EXECUTION_GATEWAY_API_KEY}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value: unknown = JSON.parse(await readLimited(response.body, response.ok ? maximum : 16 * 1024, signal));
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
  async submit(input: ReadInput, idempotencyKey: string, clientContext: ReadContext): Promise<{ id: string; status: JobStatus }> {
    const result = object(await this.request("/v1/jobs", {
      machineId: input.machineId, idempotencyKey, clientContext,
      request: { operation: "filesystem.read_file", params: { path: input.path, cwd: input.cwd, max_bytes: PI_READ_MAX_FILE_BYTES } },
    }));
    if (typeof result.status !== "string" || !statuses.includes(result.status)) throw new Error("Invalid execution gateway acceptance.");
    return { id: parseUuid(result.id), status: result.status as JobStatus };
  }
  async outcome(expected: ExpectedJob): Promise<OperationOutcome> {
    // Only terminal submission replay reads detail. Callbacks contain the signed bytes and paging context.
    const body = object(await this.request(`/v1/jobs/${encodeURIComponent(expected.id)}`, undefined, 18 * 1024 * 1024));
    const metadata = job(body);
    if (metadata.id !== expected.id || !jsonEquals(metadata.clientContext, expected.clientContext)
      || metadata.idempotencyKey !== expected.idempotencyKey || metadata.machineId !== expected.machineId
      || (expected.status !== undefined && metadata.status !== expected.status)
      || (expected.runtimeGenerationId !== undefined && metadata.runtimeGenerationId !== expected.runtimeGenerationId)) {
      throw new Error("Gateway terminal job changed or conflicts with retained correlation.");
    }
    return terminalOutcome(metadata, body.response, body.error, metadata.clientContext, this.env, this.signal);
  }
}
export function submissionRejected(error: unknown): error is GatewayError {
  return error instanceof GatewayError && [400, 404, 409, 413, 415].includes(error.status)
    && ["invalid_argument", "not_found", "machine_disabled", "payload_too_large", "unsupported_media_type"].includes(error.code);
}
