import type { LogSettings } from "@managed-agents/diagnostics";
import type { BashWorkerBinding, LlmWorkerBinding } from "@managed-agents/contracts";
import type { MinimalBashSessionV7 } from "./session.ts";

export interface Env extends LogSettings {
  MINIMAL_BASH_SESSIONS: DurableObjectNamespace<MinimalBashSessionV7>;
  LLM: LlmWorkerBinding;
  BASH: BashWorkerBinding;
  SESSION_DIRECTORY: D1Database;
}
