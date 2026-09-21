import { canonical, GatewayError, integer, jsonValue, object, text, uuid } from "./validation.ts";
import type { Json } from "./validation.ts";
import type { SecretKind } from "./protocol.ts";
const encoder = new TextEncoder();
const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
function encode(value: Uint8Array): string { let s = ""; for (let i = 0; i < value.length; i += 8192) s += String.fromCharCode(...value.subarray(i, i + 8192)); return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function decode(value: string): Uint8Array<ArrayBuffer> { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("encoding"); return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
async function key(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || encoder.encode(secret).length < 32) throw new GatewayError(503, "AUTH_NOT_CONFIGURED", "Signing secret must contain at least 32 bytes.");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sha256(value: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(n => n.toString(16).padStart(2, "0")).join(""); }
export const hashJson = (value: Json) => sha256(canonical(value));
/** This envelope authorizes result routing, never execution. No time expiry. */
export async function signRoutingEnvelope(secret: string | undefined, fields: Record<string, unknown>): Promise<string> {
  const payload = encode(encoder.encode(JSON.stringify({ ...fields, kind: "routing", aud: "managed-execution-v1" })));
  const message = `${header}.${payload}`;
  return `${message}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(message))))}`;
}
export async function verifyRoutingEnvelope(secret: string | undefined, previous: string | undefined, token: string): Promise<Record<string, unknown>> {
  const current = await key(secret);
  try {
    if (token.length > 32768) throw Error();
    const [h, payload, signature, extra] = token.split(".");
    if (h !== header || !payload || !signature || extra !== undefined) throw Error();
    const message = encoder.encode(`${h}.${payload}`), sig = decode(signature);
    let valid = await crypto.subtle.verify("HMAC", current, sig, message);
    if (!valid && previous) valid = await crypto.subtle.verify("HMAC", await key(previous), sig, message);
    if (!valid) throw Error();
    const claims = object(jsonValue(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decode(payload)))));
    if (claims.kind !== "routing" || claims.aud !== "managed-execution-v1") throw Error();
    return claims;
  } catch (error) { if (error instanceof GatewayError && error.status === 503) throw error; throw new GatewayError(401, "INVALID_ENVELOPE", "Invalid routing envelope."); }
}
export function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match || match[1]!.length > 32768) throw new GatewayError(401, "UNAUTHORIZED", "Expected bearer token.");
  return match[1]!;
}
export function constantEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export async function authenticateManagement(request: Request, secret: string | undefined): Promise<void> {
  if (!secret || encoder.encode(secret).length < 32) throw new GatewayError(503, "AUTH_NOT_CONFIGURED", "Management authentication is not configured.");
  if (!constantEqual(await sha256(bearer(request)), await sha256(secret))) throw new GatewayError(401, "UNAUTHORIZED", "Invalid management credential.");
}
export function digest(value: unknown): string { const s = text(value, 64); if (!/^[0-9a-f]{64}$/.test(s)) throw new GatewayError(400, "INVALID_REQUEST", "Expected SHA-256 digest."); return s; }
export function machineSecret(value: string, kind: SecretKind): { machineId: string; version: number } {
  try {
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== (kind === "daemon" ? "md1" : "me1") || !/^[1-9][0-9]*$/.test(parts[2]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3]!)) throw Error();
    return { machineId: uuid(parts[1]), version: integer(Number(parts[2]), 1, Number.MAX_SAFE_INTEGER) };
  } catch { throw new GatewayError(401, "INVALID_SECRET", "Invalid machine secret."); }
}
/** Stable deployment key + machine + role + version recover lost issuance responses.
 * Authorization checks stored hashes. Keep the issuance key stable. */
export async function issueMachineSecret(secret: string | undefined, machineId: string, kind: SecretKind, version: number): Promise<string> {
  uuid(machineId); integer(version, 1, Number.MAX_SAFE_INTEGER);
  const prefix = `${kind === "daemon" ? "md1" : "me1"}.${machineId}.${version}`;
  return `${prefix}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode("machine-credential-v1:" + prefix))))}`;
}
