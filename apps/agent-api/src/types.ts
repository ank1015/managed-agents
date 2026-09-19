/** Structural binding contract: never import a concrete harness implementation here. */
export interface SessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { sessionRequest(serialized: string): Promise<string> };
}
export interface Env {
  SESSION_DIRECTORY: D1Database;
  MINIMAL_BASH_SESSIONS?: SessionNamespace;
  BACKEND_TOKEN: string;
}
