import type { SqlStorage } from "@cloudflare/workers-types";
import type { OperationId, OperationRequest, SessionIdentity } from "@managed-agents/contracts";

/** Invocation-scoped capabilities for trusted harness code; not a SQL sandbox. */
export interface HarnessContext<Config> {
  readonly session: SessionIdentity;
  /** Persisted configuration; readonly is shallow and not a runtime freeze. */
  readonly config: Readonly<Config>;
  /** Use only harness-owned tables and consume cursors before returning. */
  readonly sql: Pick<SqlStorage, "exec">;
  /** Requires a declared provider/type/version. Records metadata and temporary input in this transaction. */
  requestOperation(request: OperationRequest): OperationId;
}
