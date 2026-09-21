import type { LogSettings } from "@managed-agents/diagnostics";
import type { SessionReply } from "@managed-agents/contracts";

/** Structural binding contract: never import a concrete harness implementation here. */
export interface SessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { sessionRequest(command: unknown): Promise<SessionReply<unknown>> };
}
export interface Env extends LogSettings {
  SESSION_DIRECTORY: D1Database;
  PI_NO_COMPACTION_SESSIONS?: SessionNamespace;
  MINIMAL_BASH_SESSIONS?: SessionNamespace;
  BACKEND_TOKEN: string;
}
