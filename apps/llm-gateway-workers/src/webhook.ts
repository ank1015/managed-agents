import { Logger } from "@managed-agents/diagnostics";
import type { LogFields } from "@managed-agents/diagnostics";
import { parseJsonValue, parseUuid } from "@managed-agents/contracts";
import { verifySignature } from "./crypto.ts";
import { BodyTooLarge, readLimited, terminalOutcome } from "./gateway.ts";
import type { JobStatus } from "./gateway.ts";
import { LlmService } from "./service.ts";
import type { WebhookEvent } from "./service.ts";
import { parseClientContext } from "./context.ts";
import { withDeadline } from "./deadline.ts";
import type { Env } from "./types.ts";

export async function webhook(request: Request, env: Env): Promise<Response> {
  const logger = new Logger("llm-worker", env), started = Date.now();
  const diagnostic = { fields: { stage: "validate" } as LogFields, authenticated: false };
  let response: Response;
  try { response = await withDeadline(signal => receive(request, env, signal, diagnostic)); }
  catch { response = new Response(null, { status: 503 }); }
  const fields = { ...diagnostic.fields, httpStatus: response.status, durationMs: Date.now() - started };
  if (response.status >= 500) logger.error("callback_failed", { ...fields,
    errorCode: !env.GATEWAY_WEBHOOK_SECRET ? "MISSING_WEBHOOK_SECRET" : "CALLBACK_UNAVAILABLE", retryable: true });
  else if (diagnostic.authenticated && response.status >= 400) logger.error("callback_invalid", {
    ...fields, errorCode: "AUTHENTICATED_CALLBACK_INVALID", retryable: false });
  else if (response.status === 401) logger.rejection("callback_unauthorized", { stage: "authenticate", httpStatus: 401 });
  return response;
}

async function receive(request: Request, env: Env, signal: AbortSignal,
  diagnostic: { fields: LogFields; authenticated: boolean }): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!env.GATEWAY_WEBHOOK_SECRET) return new Response(null, { status: 503 });
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return new Response(null, { status: 415 });
  const timestamp = request.headers.get("x-llm-gateway-timestamp") ?? "";
  const eventId = request.headers.get("x-llm-gateway-event-id") ?? "";
  const signature = request.headers.get("x-llm-gateway-signature") ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return new Response(null, { status: 401 });
  let body: string;
  // Bound transport before parsing; oversized inline outcomes within this cap
  // become a small terminal failure instead of stranding the session.
  try { body = await readLimited(request.body, 32 * 1024 * 1024, signal); }
  catch (error) {
    signal.throwIfAborted();
    return new Response(null, { status: error instanceof BodyTooLarge ? 413 : 400 });
  }
  const data = `${timestamp}.${eventId}.${body}`;
  const current = await verifySignature(env.GATEWAY_WEBHOOK_SECRET, signature, data);
  const previous = !current && env.GATEWAY_PREVIOUS_WEBHOOK_SECRET
    ? await verifySignature(env.GATEWAY_PREVIOUS_WEBHOOK_SECRET, signature, data) : false;
  if (!current && !previous) return new Response(null, { status: 401 });
  diagnostic.authenticated = true;
  diagnostic.fields.stage = "parse_callback";
  let event: WebhookEvent;
  try {
    const value = parseJsonValue(JSON.parse(body));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join() !== "clientContext,completedAt,error,eventId,jobId,response,schemaVersion,type"
      || value.schemaVersion !== 2
      || value.eventId !== eventId || !["job.succeeded", "job.failed", "job.cancelled"].includes(String(value.type))
      || typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))) throw new Error("Invalid event.");
    const jobId = parseUuid(value.jobId);
    event = { eventId: parseUuid(value.eventId), jobId,
      type: value.type as WebhookEvent["type"], completedAt: value.completedAt, clientContext: parseClientContext(value.clientContext),
      outcome: terminalOutcome(jobId, String(value.type).slice(4) as JobStatus, value.response, value.error) };
  } catch { return new Response(null, { status: 400 }); }
  Object.assign(diagnostic.fields, { stage: "deliver_completion", sessionId: event.clientContext.sessionId,
    operationId: event.clientContext.operationId, gatewayJobId: event.jobId });
  try {
    await new LlmService(env).deliver(event, signal);
    return new Response(null, { status: 204 });
  } catch {
    // The gateway retries. No local ledger or background work can recover an early acknowledgement.
    return new Response(null, { status: 503 });
  }
}
