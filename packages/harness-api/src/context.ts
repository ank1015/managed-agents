import type { SqlStorage } from "@cloudflare/workers-types";
import type { OperationId, SessionIdentity } from "@managed-agents/contracts";

/** Invocation-scoped capabilities for trusted harness code, not a SQL sandbox. */
export interface HarnessInitializationContext<Config> {
  readonly session: SessionIdentity;
  readonly config: Readonly<Config>;
  readonly sql: Pick<SqlStorage, "exec">;
}
export type HarnessWriteContext<Config> = HarnessInitializationContext<Config>;
export interface HarnessReadContext<Config> {
  readonly session: SessionIdentity;
  readonly config: Readonly<Config>;
  /** Single SELECT statements only. Read harness-owned tables, not runtime admission state. */
  readonly sql: Pick<SqlStorage, "exec">;
  /** Pure identity calculation, stable across replay. Keys must be unique in the returned plan. */
  operationId(key: string): OperationId;
}
