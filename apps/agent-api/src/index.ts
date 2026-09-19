import { parseJsonValue, parseSubmitInputRequest, parseMessagePageQuery } from "@managed-agents/contracts";
import type { InputReceipt } from "@managed-agents/contracts";
import { authenticateBackend } from "./auth.ts";
import { callSession } from "./harness-routing.ts";
import { ApiError, decodePath, errorResponse, json, method, noQuery, notFound, readJson } from "./http.ts";
import { createSession } from "./sessions/create.ts";
import { SessionDirectory } from "./sessions/directory.ts";
import type { Env } from "./types.ts";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") { method(request, "GET"); noQuery(url); return json({ ok: true }); }
  await authenticateBackend(request, env);
  if (url.pathname === "/v1/sessions") {
    noQuery(url);
    if (request.method === "GET") return json(await new SessionDirectory(env.SESSION_DIRECTORY).list());
    if (request.method === "POST") {
      const created = await createSession(env, await readJson(request));
      return json(created, created.duplicate ? 200 : 201);
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST.");
  }
  const match = /^\/v1\/sessions\/([^/]+)\/(inputs|messages|pending-messages)$/.exec(url.pathname);
  if (!match) throw notFound();
  const sessionId = decodePath(match[1]!);
  if (match[2] !== "inputs") {
    method(request, "GET");
    for (const key of url.searchParams.keys()) {
      if (!["after", "limit"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_REQUEST", "Expected only after and limit query parameters.");
    }
    for (const value of url.searchParams.values()) if (!/^\d+$/.test(value)) throw new ApiError(400, "INVALID_REQUEST", "Pagination values must be unsigned integers.");
    const page = parseMessagePageQuery({ ...(url.searchParams.has("after") ? { after: Number(url.searchParams.get("after")) } : {}),
      ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}) });
    const entry = await new SessionDirectory(env.SESSION_DIRECTORY).readyEntry(sessionId);
    if (entry.route_key !== "minimal-bash-v1") throw notFound();
    return json(await callSession(env, entry.route_key, sessionId, { action: match[2] === "messages" ? "getMessages" : "getPendingMessages", value: page }));
  }
  method(request, "POST");
  noQuery(url);
  const entry = await new SessionDirectory(env.SESSION_DIRECTORY).readyEntry(sessionId);
  const input = parseSubmitInputRequest(await readJson(request));
  return json(await callSession<InputReceipt>(env, entry.route_key, sessionId,
    { action: "appendInput", value: parseJsonValue(input) }), 202);
}

export default {
  async fetch(request, env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      response = errorResponse(error);
      if (response.status === 405 && error instanceof ApiError) response.headers.set("Allow", error.message.slice(4, -1));
    }
    if (response.status === 401) response.headers.set("WWW-Authenticate", "Bearer");
    if (response.status === 503) response.headers.set("Retry-After", "1");
    return response;
  },
} satisfies ExportedHandler<Env>;
