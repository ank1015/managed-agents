import type { AbortSignal } from "@cloudflare/workers-types";
import type { ProviderSubmission, ProviderSubmitResult } from "@managed-agents/contracts";
/** Worker owns execution AND durable completion delivery after acceptance. */
export interface OperationProvider {
  /** Identical IDs/inputs replay the same acceptance/rejection for the full recovery horizon.
   * Throw on ambiguous/transient failure. A timeout never proves non-acceptance.
   * Propagate signal where supported. Never await completion delivery before returning acceptance. */
  submit(submission: ProviderSubmission, signal: AbortSignal): Promise<ProviderSubmitResult>;
}
export type ProviderRegistry = Readonly<Record<string, OperationProvider>>;
