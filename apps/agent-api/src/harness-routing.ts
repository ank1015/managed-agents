import { ContractException } from "@managed-agents/contracts";
import type { HarnessIdentity, SessionCommand, SessionReply } from "@managed-agents/contracts";
import { ApiError } from "./http.ts";
import type { Env, SessionNamespace } from "./types.ts";

// Deployment metadata only. Route keys and existing namespace bindings must remain stable.
const routes = [
  { key: "pi-no-compaction-v1", harness: { id: "pi-no-compaction", version: "v1" }, binding: "PI_NO_COMPACTION_SESSIONS" },
  { key: "minimal-bash-v7", harness: { id: "minimal-bash", version: "v7" }, binding: "MINIMAL_BASH_SESSIONS" },
] as const;
export function creationRoute(harness: HarnessIdentity) {
  const route = routes.find(route => harness.id === route.harness.id && harness.version === route.harness.version);
  if (!route) throw new ApiError(400, "UNSUPPORTED_HARNESS", "Unsupported harness or version.");
  return route;
}
export function routeNamespace(env: Env, key: string): SessionNamespace {
  const route = routes.find(route => route.key === key);
  const namespace = route && env[route.binding];
  if (!namespace) throw new ApiError(503, "ROUTE_UNAVAILABLE", "Session deployment is unavailable.");
  return namespace;
}
export async function callSession<T>(env: Env, routeKey: string, sessionId: string, command: SessionCommand): Promise<T> {
  const namespace = routeNamespace(env, routeKey);
  const reply = await namespace.get(namespace.idFromName(sessionId)).sessionRequest(command) as SessionReply<T>;
  if (!reply.ok) throw new ContractException(reply.error.code, reply.error.message);
  return reply.value;
}
