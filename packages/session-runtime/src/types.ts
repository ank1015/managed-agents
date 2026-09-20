import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { HarnessStatus, ProviderSubmission, ProviderSubmitResult } from "@managed-agents/contracts";
import type { PendingInput } from "./storage/inbox.ts";
export type RuntimeStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
export interface PreparedTransition<Changes = unknown> {
  readonly input: PendingInput;
  readonly changes: Changes;
  readonly operations: readonly (ProviderSubmission & { key: string })[];
  readonly status?: HarnessStatus;
}
export interface SubmissionReceipt { operationId: string; result: ProviderSubmitResult }
export type ProcessNextResult =
  | { processed: false }
  | { processed: true; eventId: string; sequence: number; status?: HarnessStatus };
