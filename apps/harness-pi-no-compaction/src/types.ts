import type { LogSettings } from "@managed-agents/diagnostics";
import type { BashWorkerBinding, ReadWorkerBinding, EditWorkerBinding, WriteWorkerBinding, LlmWorkerBinding } from "@managed-agents/contracts";
import type { PiNoCompactionSessionV1 } from "./session.ts";

export interface Env extends LogSettings {
  PI_NO_COMPACTION_SESSIONS: DurableObjectNamespace<PiNoCompactionSessionV1>;
  LLM: LlmWorkerBinding;
  BASH: BashWorkerBinding;
  READ: ReadWorkerBinding;
  EDIT: EditWorkerBinding;
  WRITE: WriteWorkerBinding;
  SESSION_DIRECTORY: D1Database;
}
