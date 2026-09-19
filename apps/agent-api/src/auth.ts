import { ApiError } from "./http.ts";
import type { Env } from "./types.ts";

async function authenticate(request: Request, secret: string | undefined): Promise<void> {
  if (!secret) throw new ApiError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured.");
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!match || match[1]!.length > 4096) throw new ApiError(401, "UNAUTHORIZED", "Invalid bearer token.");
  // Hash both values before fixed-length comparison; never log either credential.
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match[1]!)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  if (difference !== 0) throw new ApiError(401, "UNAUTHORIZED", "Invalid bearer token.");
}
export async function authenticateBackend(request: Request, env: Env): Promise<void> {
  await authenticate(request, env.BACKEND_TOKEN);
}
