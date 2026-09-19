import type { AbortSignal } from "@cloudflare/workers-types";
import type {
  ProviderStatusQuery, ProviderSubmission, ProviderSubmitResult, ProviderStatusResult,
} from "@managed-agents/contracts";

/** Transport/authentication live in adapters supplied by the deployment. */
export interface OperationProvider {
  /** Repeating a submissionId MUST return the same durable job for identical immutable input.
   * Acceptance transfers execution/recovery ownership to the worker; the session deletes its input.
   * Throw on uncertain/transient failure; only return rejected for definitive non-acceptance.
   * Propagate signal into network requests. Timeout never proves rejection. */
  submit(submission: ProviderSubmission, signal: AbortSignal): Promise<ProviderSubmitResult>;
  /** Query accepted jobs without their original input. A missing job never authorizes resubmission.
   * Terminal results must remain queryable for the session's recovery horizon. */
  get(query: ProviderStatusQuery, signal: AbortSignal): Promise<ProviderStatusResult>;
}

export type ProviderRegistry = Readonly<Record<string, OperationProvider>>;
