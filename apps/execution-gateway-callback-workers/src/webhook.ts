import { Logger } from "@managed-agents/diagnostics";
import type { LogFields } from "@managed-agents/diagnostics";
import { parseExecutionGatewayEvent } from "@managed-agents/contracts";
import { withDeadline } from "./deadline.ts";
import { CallbackService } from "./service.ts";
import type { Env } from "./types.ts";

export async function webhook(request: Request, env: Env): Promise<Response> {
  const logger = new Logger("execution-callback", env), started = Date.now();
  const diagnostic = { fields: { stage: "validate" } as LogFields, authenticated: false };
  let response: Response;
  try { response = await withDeadline(signal => receive(request, env, signal, diagnostic)); }
  catch { response = new Response(null, { status: 503 }); }
  const fields = { ...diagnostic.fields, httpStatus: response.status, durationMs: Date.now() - started };
  if (response.status >= 500) logger.error("callback_failed", { ...fields,
    errorCode: !env.EXECUTION_GATEWAY_WEBHOOK_SECRET ? "MISSING_WEBHOOK_SECRET" : "CALLBACK_UNAVAILABLE", retryable: true });
  else if (diagnostic.authenticated && response.status >= 400) logger.error("callback_invalid", {
    ...fields, errorCode: "AUTHENTICATED_CALLBACK_INVALID", retryable: false });
  else if (response.status === 401) logger.rejection("callback_unauthorized", { stage: "authenticate", httpStatus: 401 });
  return response;
}
async function receive(request: Request, env: Env, signal: AbortSignal,
  diagnostic: { fields: LogFields; authenticated: boolean }): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!env.EXECUTION_GATEWAY_WEBHOOK_SECRET) return new Response(null, { status: 503 });
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return new Response(null, { status: 415 });
  const timestamp = request.headers.get("x-execution-gateway-timestamp") ?? "";
  const eventId = request.headers.get("x-execution-gateway-event-id") ?? "";
  const signature = request.headers.get("x-execution-gateway-signature") ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return new Response(null, { status: 401 });
  let body: string;
  try { body = await readBody(request.body, signal); }
  catch (error) { signal.throwIfAborted(); return new Response(null, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
  const data = `${timestamp}.${eventId}.${body}`;
  const current = await verify(env.EXECUTION_GATEWAY_WEBHOOK_SECRET, signature, data);
  const previous = !current && env.EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET
    ? await verify(env.EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET, signature, data) : false;
  if (!current && !previous) return new Response(null, { status: 401 });
  diagnostic.authenticated = true;
  diagnostic.fields.stage = "parse_callback";
  let event;
  try { event = parseExecutionGatewayEvent(JSON.parse(body)); }
  catch { return new Response(null, { status: 400 }); }
  if (event.eventId !== eventId) return new Response(null, { status: 400 });
  Object.assign(diagnostic.fields, { stage: "route_completion", sessionId: event.clientContext.sessionId,
    operationId: event.clientContext.operationId, gatewayJobId: event.jobId });
  try {
    const service = new CallbackService(env);
    await service.deliver(event, signal);
    return new Response(null, { status: 204 });
  } catch {
    // No intermediate persistence: failures must reach the gateway for redelivery.
    return new Response(null, { status: 503 });
  }
}
async function verify(secret: string, signature: string, data: string): Promise<boolean> {
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.slice(3).match(/../g)!, byte => parseInt(byte, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(data));
}
class BodyTooLarge extends Error {}
async function readBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<string> {
  if (!body) return "";
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 18 * 1024 * 1024) { await reader.cancel(); throw new BodyTooLarge(); }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
