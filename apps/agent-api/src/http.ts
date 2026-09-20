import { ContractException } from "@managed-agents/contracts";
import type { ContractErrorCode } from "@managed-agents/contracts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
const statuses: Record<ContractErrorCode, number> = {
  INVALID_REQUEST: 400, INVALID_CONFIG: 400, INVALID_INPUT: 400,
  SESSION_NOT_INITIALIZED: 409, INITIALIZATION_CONFLICT: 409, INPUT_CONFLICT: 409,
  OPERATION_NOT_FOUND: 404, COMPLETION_CONFLICT: 409,
};
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof ContractException) return json({ error: error.toJSON() }, statuses[error.code]);
  return json({ error: { code: "UNAVAILABLE", message: "Service temporarily unavailable. Retry with the same request identity." } }, 503);
}
export const notFound = () => new ApiError(404, "NOT_FOUND", "Resource not found.");
export function method(request: Request, expected: string): void {
  if (request.method !== expected) throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${expected}.`);
}
export const MAX_BODY_BYTES = 64 * 1024;
export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use Content-Type: application/json.");
  }
  if (!request.body) throw new ContractException("INVALID_REQUEST", "Expected a JSON body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ApiError(413, "BODY_TOO_LARGE", "JSON body exceeds 64 KiB."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown; }
  catch { throw new ContractException("INVALID_REQUEST", "Expected a valid JSON body."); }
}
export function noQuery(url: URL): void {
  if (url.search) throw new ContractException("INVALID_REQUEST", "Unexpected query parameters.");
}
export function decodePath(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new ContractException("INVALID_REQUEST", "Malformed path encoding."); }
}
