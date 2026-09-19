import type { SessionDestination } from "@managed-agents/contracts";

export type Work = { kind: "operation" | "event"; id: string };
export interface SessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { sessionRequest(serialized: string): Promise<string> };
}
export interface Env {
  LLM_DB: D1Database;
  COMPLETIONS: Queue<Work>;
  GATEWAY_URL: string;
  GATEWAY_API_KEY: string;
  GATEWAY_WEBHOOK_SECRET: string;
  GATEWAY_PREVIOUS_WEBHOOK_SECRET?: string;
  SESSION_ROUTES: string;
  [binding: string]: unknown;
}
export function sessionNamespace(env: Env, destination: SessionDestination): SessionNamespace {
  const routes: unknown = JSON.parse(env.SESSION_ROUTES);
  if (!routes || typeof routes !== "object" || Array.isArray(routes) || !Object.hasOwn(routes, destination.routeKey)) {
    throw new Error("Session route is not configured.");
  }
  const binding: unknown = (routes as Record<string, unknown>)[destination.routeKey];
  const namespace = typeof binding === "string" ? env[binding] as SessionNamespace | undefined : undefined;
  if (!namespace || typeof namespace.get !== "function" || typeof namespace.idFromName !== "function") {
    throw new Error("Session namespace binding is not configured.");
  }
  return namespace;
}
