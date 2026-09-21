export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export class GatewayError extends Error {
  readonly status: number; readonly code: string; readonly retryable: boolean; readonly uncertain: boolean;
  constructor(status: number, code: string, message: string, retryable = false, uncertain = false) {
    super(message); this.status = status; this.code = code; this.retryable = retryable; this.uncertain = uncertain;
  }
}
export const invalid = (message: string) => new GatewayError(400, "INVALID_REQUEST", message);
export function object(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Expected an object.");
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) throw invalid("Unexpected field.");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid("Expected a bounded nonempty string without control characters.");
  return value;
}
export function messageText(value: unknown, max = 8192): string {
  if (typeof value !== "string" || !value.length || value.length > max) throw invalid("Invalid error message.");
  return value;
}
export function identity(value: unknown): string {
  const s = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(s)) throw invalid("Invalid identity.");
  return s;
}
export function uuid(value: unknown): string {
  const s = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) throw invalid("Expected a lowercase UUID.");
  return s;
}
export function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid("Integer is out of range.");
  return value as number;
}
export function bool(value: unknown): boolean { if (typeof value !== "boolean") throw invalid("Expected boolean."); return value; }
export const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
/** Bound recursion and object count as well as wire bytes. */
export function jsonValue(value: unknown): Json {
  let count = 0;
  function visit(v: unknown, depth: number): asserts v is Json {
    if (++count > 100_000 || depth > 64) throw invalid("JSON structure exceeds limits.");
    if (v === null || typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return;
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    if (v && typeof v === "object") { for (const item of Object.values(v)) visit(item, depth + 1); return; }
    throw invalid("Expected JSON.");
  }
  visit(value, 0); return value;
}
export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function errorResponse(error: unknown): Response {
  const e = error instanceof GatewayError ? error : new GatewayError(503, "UNAVAILABLE", "Service unavailable; retry with the same request identity.", true, true);
  const response = jsonResponse({ error: { code: e.code, message: e.message, retryable: e.retryable, uncertain: e.uncertain } }, e.status);
  if (e.status === 401) response.headers.set("WWW-Authenticate", "Bearer");
  if (e.retryable) response.headers.set("Retry-After", "1");
  return response;
}
export async function readJson(request: Request, limit: number, timeoutMs = 8000, reserve?: (bytes: number) => void): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new GatewayError(415, "CONTENT_TYPE", "Use application/json.");
  if (!request.body) throw invalid("Expected JSON body.");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new GatewayError(408, "BODY_TIMEOUT", "Request body deadline exceeded.")); }, timeoutMs); });
    const read = async () => {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
        if (size > limit) { void reader.cancel().catch(() => {}); throw new GatewayError(413, "BODY_TOO_LARGE", "Request exceeds byte limit."); } try { reserve?.(value.byteLength); } catch (error) { void reader.cancel().catch(() => {}); throw error; } chunks.push(value); }
      const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      try { return jsonValue(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data))); } catch (error) { if (error instanceof GatewayError) throw error; throw invalid("Invalid JSON."); }
    };
    return await Promise.race([read(), timeout]);
  } finally { if (timer !== undefined) clearTimeout(timer); reader.releaseLock(); }
}
export async function deadline<T>(work: Promise<T>, ms: number, error: GatewayError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
export function configured(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  try { return integer(n, min, max); } catch { throw new GatewayError(503, "INVALID_CONFIGURATION", "Invalid configured limit."); }
}
