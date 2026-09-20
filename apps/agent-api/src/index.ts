import { parseMessagePageQuery } from "@managed-agents/contracts";
import { Logger } from "@managed-agents/diagnostics";
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
    if (entry.route_key !== "minimal-bash-v7") throw notFound();
    const result = await callSession<{ messages: unknown[]; nextCursor: number | null; state: Record<string, unknown> }>(env, entry.route_key, sessionId,
      { action: match[2] === "messages" ? "getMessages" : "getPendingMessages", value: page });
    // Display status belongs to D1; the DO returns only its execution state.
    return json({ ...result, state: { ...result.state, status: entry.status } });
  }
  method(request, "POST");
  noQuery(url);
  const entry = await new SessionDirectory(env.SESSION_DIRECTORY).readyEntry(sessionId);
  // HTTP handles syntax/size; the addressed DO validates the input contract once.
  const input = await readJson(request);
  return json(await callSession<InputReceipt>(env, entry.route_key, sessionId,
    { action: "appendInput", value: input }), 202);
}

export default {
  async fetch(request, env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      response = errorResponse(error);
      if (response.status >= 500) {
        const path = new URL(request.url).pathname;
        const match = /^\/v1\/sessions\/(ses_[0-9a-f-]{36})\/(inputs|messages|pending-messages)$/.exec(path);
        new Logger("agent-api", env).error("request_failed", {
          stage: path === "/v1/sessions" ? (request.method === "POST" ? "create_session" : "list_sessions") : match?.[2] ?? "route",
          ...(match?.[1] ? { sessionId: match[1] } : {}),
          errorCode: "API_UNAVAILABLE", httpStatus: response.status, retryable: true,
        });
      }
      if (response.status === 405 && error instanceof ApiError) response.headers.set("Allow", error.message.slice(4, -1));
    }
    if (response.status === 401) {
      response.headers.set("WWW-Authenticate", "Bearer");
      new Logger("agent-api", env).rejection("request_unauthorized", { stage: "authenticate", httpStatus: 401 });
    }
    if (response.status === 503) response.headers.set("Retry-After", "1");
    return response;
  },
} satisfies ExportedHandler<Env>;
