import { authenticateManagement, errorResponse, GatewayError, object, readJson, uuid } from "@managed-agents/execution-gateway-protocol";
import type { Env } from "./types.ts";
export { Machine } from "./machine.ts";
export type { Env } from "./types.ts";
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.search) throw new GatewayError(400, "INVALID_REQUEST", "Query parameters are not supported.");
  if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true, service: "execution-gateway", protocolVersion: 1 });
  let machineId: string, path: string;
  if (url.pathname === "/v1/machines") {
    if (request.method !== "POST") throw new GatewayError(405, "METHOD_NOT_ALLOWED", "Use POST.");
    await authenticateManagement(request, env.MANAGEMENT_SECRET);
    const body = object(await readJson(request, 16384), ["machineId", "name"]);
    machineId = uuid(body.machineId); path = "/register";
    request = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) });
  } else {
    const match = /^\/v1\/machines\/([^/]+)(?:\/(connect|requests|secrets\/rotate))?$/.exec(url.pathname);
    if (!match) throw new GatewayError(404, "NOT_FOUND", "Route not found.");
    machineId = uuid(match[1]); path = match[2] ? "/" + match[2] : "/";
    if (path === "/secrets/rotate" || (path === "/" && request.method === "DELETE")) await authenticateManagement(request, env.MANAGEMENT_SECRET);
  }
  const headers = new Headers(request.headers);
  headers.set("X-Execution-Machine", machineId);
  const forwarded = new Request("https://machine.internal" + path, { method: request.method, headers,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }), redirect: "manual" });
  return env.MACHINES.get(env.MACHINES.idFromName(machineId)).fetch(forwarded);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<Env>;
