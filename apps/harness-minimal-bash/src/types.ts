import type { BashWorkerBinding, LlmWorkerBinding } from "@managed-agents/contracts";
import type { MinimalBashSession } from "./session.ts";

export interface Env {
  MINIMAL_BASH_SESSIONS: DurableObjectNamespace<MinimalBashSession>;
  LLM: LlmWorkerBinding;
  BASH: BashWorkerBinding;
  SESSION_DIRECTORY: D1Database;
}
