import { parseJsonValue, parseUuid } from "@managed-agents/contracts";
import { verifySignature } from "./crypto.ts";
import { BodyTooLarge, readLimited } from "./gateway.ts";
import { LlmService } from "./service.ts";
import type { WebhookEvent } from "./store.ts";
import type { Env } from "./types.ts";

export async function webhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!env.GATEWAY_WEBHOOK_SECRET) return new Response(null, { status: 503 });
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return new Response(null, { status: 415 });
  const timestamp = request.headers.get("x-llm-gateway-timestamp") ?? "";
  const eventId = request.headers.get("x-llm-gateway-event-id") ?? "";
  const signature = request.headers.get("x-llm-gateway-signature") ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return new Response(null, { status: 401 });
  let body: string;
  try { body = await readLimited(request.body, 16 * 1024); }
  catch (error) { return new Response(null, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
  const data = `${timestamp}.${eventId}.${body}`;
  const current = await verifySignature(env.GATEWAY_WEBHOOK_SECRET, signature, data);
  const previous = !current && env.GATEWAY_PREVIOUS_WEBHOOK_SECRET
    ? await verifySignature(env.GATEWAY_PREVIOUS_WEBHOOK_SECRET, signature, data) : false;
  if (!current && !previous) return new Response(null, { status: 401 });
  let event: WebhookEvent;
  try {
    const value = parseJsonValue(JSON.parse(body));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join() !== "completedAt,eventId,jobId,type"
      || value.eventId !== eventId || !["job.succeeded", "job.failed", "job.cancelled"].includes(String(value.type))
      || typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))) throw new Error("Invalid event.");
    event = { eventId: parseUuid(value.eventId), jobId: parseUuid(value.jobId),
      type: value.type as WebhookEvent["type"], completedAt: value.completedAt };
  } catch { return new Response(null, { status: 400 }); }
  try {
    const service = new LlmService(env);
    await service.store.event(event);
    ctx.waitUntil(service.kick({ kind: "event", id: event.eventId }));
    return new Response(null, { status: 204 });
  } catch {
    // 503 is retryable by the gateway. Never acknowledge an event that wasn't persisted.
    return new Response(null, { status: 503 });
  }
}
