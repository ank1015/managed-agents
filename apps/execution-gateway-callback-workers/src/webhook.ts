import { parseExecutionGatewayEvent } from "@managed-agents/contracts";
import { CallbackService } from "./service.ts";
import type { Env } from "./types.ts";

export async function webhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!env.EXECUTION_GATEWAY_WEBHOOK_SECRET) return new Response(null, { status: 503 });
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return new Response(null, { status: 415 });
  const timestamp = request.headers.get("x-execution-gateway-timestamp") ?? "";
  const eventId = request.headers.get("x-execution-gateway-event-id") ?? "";
  const signature = request.headers.get("x-execution-gateway-signature") ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return new Response(null, { status: 401 });
  let body: string;
  try { body = await readBody(request.body); }
  catch (error) { return new Response(null, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
  const data = `${timestamp}.${eventId}.${body}`;
  const current = await verify(env.EXECUTION_GATEWAY_WEBHOOK_SECRET, signature, data);
  const previous = !current && env.EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET
    ? await verify(env.EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET, signature, data) : false;
  if (!current && !previous) return new Response(null, { status: 401 });
  let event;
  try { event = parseExecutionGatewayEvent(JSON.parse(body)); }
  catch { return new Response(null, { status: 400 }); }
  if (event.eventId !== eventId) return new Response(null, { status: 400 });
  try {
    const service = new CallbackService(env);
    await service.admit(event);
    ctx.waitUntil(service.kick({ eventId: event.eventId }));
    return new Response(null, { status: 204 });
  } catch {
    // Never acknowledge an event that was not persisted, including conflicting event IDs.
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
async function readBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16 * 1024) { await reader.cancel(); throw new BodyTooLarge(); }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { reader.releaseLock(); }
}
