import type { AbortSignal as WorkerAbortSignal, DurableObjectStorage } from "@cloudflare/workers-types";
import { Logger } from "@managed-agents/diagnostics";
import { parseInitializeSessionRequest, parseProviderSubmitResult } from "@managed-agents/contracts";
import type { EventBody, CompletionReceipt, HarnessStatus, InitializeSessionResult, InputReceipt, SessionInfo, ProviderSubmitResult } from "@managed-agents/contracts";
import type { HarnessDefinition } from "@managed-agents/harness-api";
import type { ProviderRegistry } from "./provider.ts";
import { SessionRuntime } from "./runtime.ts";
import { failProcessing, processingStatus, resetProcessing } from "./storage/progress.ts";
import type { ProcessingStatus } from "./storage/progress.ts";
import { copy, freeze } from "./values.ts";
import { operationDefinitions } from "./operation-definitions.ts";
import type { RuntimeStorage, PreparedTransition, SubmissionReceipt } from "./types.ts";

export type DriverStorage = RuntimeStorage & Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">;
export interface DriverPolicy {
  maxSteps: number; maxSliceMs: number; providerTimeoutMs: number; submissionConcurrency: number;
  recoveryMs: number; continuationMs: number; retryBaseMs: number; retryMaxMs: number; maxHandlerFailures: number;
}
export const DEFAULT_DRIVER_POLICY: Readonly<DriverPolicy> = Object.freeze({
  maxSteps: 32, maxSliceMs: 250, providerTimeoutMs: 10_000, submissionConcurrency: 8,
  recoveryMs: 30_000, continuationMs: 1, retryBaseMs: 500, retryMaxMs: 60_000, maxHandlerFailures: 5,
});
export interface SessionDriverOptions {
  providers: ProviderRegistry;
  waitUntil(promise: Promise<void>): void;
  onStatusChange?(status: HarnessStatus): void;
  policy?: Partial<DriverPolicy>;
  diagnostics?: Logger;
}

/** One serialized transition processor per DO. Admission remains independent of remote submission. */
export class SessionDriver<Config, Input extends EventBody, Changes = unknown> {
  readonly #storage: DriverStorage;
  readonly #runtime: SessionRuntime<Config, Input, Changes>;
  readonly #providers: ProviderRegistry;
  readonly #waitUntil: SessionDriverOptions["waitUntil"];
  readonly #policy: Readonly<DriverPolicy>;
  readonly #onStatusChange: SessionDriverOptions["onStatusChange"];
  readonly #logger: Logger;
  #queue: Promise<unknown> = Promise.resolve();
  #running: Promise<void> | undefined;
  #requested = false;
  #receiptInput: string | undefined;
  #receipts = new Map<string, ProviderSubmitResult>();

  constructor(storage: DriverStorage, harness: HarnessDefinition<Config, Input, Changes>, options: SessionDriverOptions) {
    const policy = { ...DEFAULT_DRIVER_POLICY, ...options.policy };
    for (const [name, value] of Object.entries(policy)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid driver policy: ${name}.`);
    }
    if (policy.retryMaxMs < policy.retryBaseMs) throw new Error("retryMaxMs must be >= retryBaseMs.");
    for (const { provider } of operationDefinitions(harness.operations)) {
      if (!Object.hasOwn(options.providers, provider) || typeof options.providers[provider]?.submit !== "function") {
        throw new Error(`Provider is not configured for declared harness operations: ${provider}`);
      }
    }
    this.#storage = storage;
    this.#runtime = new SessionRuntime(storage, harness);
    this.#logger = options.diagnostics ?? new Logger("session-runtime");
    this.#providers = Object.freeze({ ...options.providers });
    this.#waitUntil = options.waitUntil;
    this.#onStatusChange = options.onStatusChange;
    this.#policy = Object.freeze(policy);
  }

  async initialize(value: unknown): Promise<InitializeSessionResult> {
    const request = copy(parseInitializeSessionRequest(value));
    return this.#locked(() => this.#runtime.initialize(request));
  }
  async appendInput(value: unknown): Promise<InputReceipt> { return this.#admit(this.#runtime.prepareInput(value)); }
  async acceptCompletion(value: unknown): Promise<CompletionReceipt> {
    const check = this.#runtime.prepareCompletion(value);
    const result = await this.#locked(async () => {
      const admission = check();
      if (!admission.consumed) await this.#arm();
      return { receipt: admission.commit(), consumed: admission.consumed };
    });
    if (!result.consumed) this.#kick();
    return result.receipt;
  }
  getSession(): SessionInfo { return this.#runtime.getSession(); }
  getPendingOperations() { return this.#runtime.getPendingOperations(); }
  getProcessingStatus(): ProcessingStatus { return processingStatus(this.#storage.sql); }
  async resumeProcessing(): Promise<void> {
    await this.#admit(() => { this.#runtime.getSession(); resetProcessing(this.#storage.sql); });
  }
  async alarm(): Promise<void> { await this.#locked(() => this.#arm()); await this.#start(true); }

  run(): Promise<void> { return this.#start(false); }
  #start(recoveryArmed: boolean): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#drain(recoveryArmed).catch(error => {
      this.#logger.error("processing_unavailable", { stage: "drain", ...this.#correlation(),
        errorCode: "RUNTIME_STORAGE_OR_ALARM_FAILURE", retryable: true });
      throw error;
    }).finally(() => {
      this.#running = undefined;
      if (this.#requested) { this.#requested = false; this.#kick(); }
    });
    return this.#running;
  }
  #kick(): void {
    if (this.#running) { this.#requested = true; return; }
    // Admission already armed recovery while holding the same processing lock.
    this.#waitUntil(this.#start(true));
  }
  async #admit<T>(commit: () => T): Promise<T> {
    const result = await this.#locked(async () => { await this.#arm(); return commit(); });
    this.#kick();
    return result;
  }
  #locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(fn); this.#queue = next.catch(() => {}); return next;
  }
  async #arm(): Promise<void> {
    const due = Date.now() + this.#policy.recoveryMs, existing = await this.#storage.getAlarm();
    if (existing === null || existing > due) await this.#storage.setAlarm(due);
  }
  #backoff(attempt: number): number {
    const cap = Math.min(this.#policy.retryMaxMs, this.#policy.retryBaseMs * 2 ** Math.min(30, attempt - 1));
    return Math.max(1, Math.round(cap * (0.5 + Math.random() * 0.5)));
  }
  #correlation(): { sessionId?: string } {
    const sessionId = this.#runtime.cachedSessionId;
    return sessionId ? { sessionId } : {};
  }
  #failed(progress: ProcessingStatus, error: unknown, handlerFailure: boolean, stage: string): void {
    const blocked = handlerFailure && progress.failures + 1 >= this.#policy.maxHandlerFailures;
    failProcessing(this.#storage.sql, progress, Date.now() + this.#backoff(progress.failures + 1),
      blocked, errorMessage(error));
    const fields = { ...this.#correlation(), stage, blocked, attempt: progress.failures + 1, retryable: !blocked,
      errorCode: handlerFailure ? "HARNESS_TRANSITION_FAILED" : "SUBMISSION_UNCERTAIN" };
    if (handlerFailure) this.#logger.error(blocked ? "processing_blocked" : "transition_failed", fields);
    else this.#logger.warn("processing_retry_scheduled", fields);
  }

  async #drain(recoveryArmed: boolean): Promise<void> {
    if (!recoveryArmed) await this.#locked(() => this.#arm());
    const started = Date.now();
    for (let step = 0; step < this.#policy.maxSteps && Date.now() - started < this.#policy.maxSliceMs; step++) {
      const work = await this.#locked(() => {
        if (!this.#runtime.initialized) return;
        const progress = processingStatus(this.#storage.sql);
        if (!progress.pendingEventId || progress.blocked || (progress.retryAt !== null && progress.retryAt > Date.now())) return;
        try {
          const prepared = this.#runtime.prepareNext();
          return prepared && { prepared, progress };
        } catch (error) { this.#failed(progress, error, true, "prepare"); return; }
      });
      if (!work) break;
      let receipts: SubmissionReceipt[];
      try { receipts = await this.#submit(work.prepared); }
      catch (error) {
        // Unknown acceptance never authorizes dropping the input or creating new operation identities.
        await this.#locked(() => this.#failed(work.progress, error, false, "submit"));
        break;
      }
      const result = await this.#locked(() => {
        try { return this.#runtime.commit(work.prepared, receipts); }
        catch (error) { this.#failed(work.progress, error, true, "commit"); return; }
      });
      if (!result) break;
      this.#receipts.clear(); this.#receiptInput = undefined;
      if (result.processed && result.status !== undefined) {
        if (result.status === "failed") this.#logger.error("run_failed", { ...this.#correlation(), stage: "harness", errorCode: "HARNESS_STOPPED", retryable: false });
        else this.#logger.success("harness_status_changed", { ...this.#correlation(), stage: "harness", outcome: result.status });
        try { this.#onStatusChange?.(result.status); }
        catch { this.#logger.error("status_publish_failed", { ...this.#correlation(), stage: "status", errorCode: "STATUS_PUBLICATION_FAILED", retryable: false }); }
      }
    }
    await this.#locked(async () => {
      const progress = processingStatus(this.#storage.sql);
      if (progress.pendingEventId === null || progress.blocked) await this.#storage.deleteAlarm();
      else await this.#storage.setAlarm(Math.max(Date.now() + this.#policy.continuationMs, progress.retryAt ?? Date.now()));
    });
  }

  async #submit(prepared: PreparedTransition<Changes>): Promise<SubmissionReceipt[]> {
    if (this.#receiptInput !== prepared.input.eventId) {
      this.#receipts.clear(); this.#receiptInput = prepared.input.eventId;
    }
    const pending = prepared.operations.filter(op => !this.#receipts.has(op.operationId));
    let cursor = 0;
    const errors: unknown[] = [];
    // Bound transport concurrency, not operation count. Observe every attempt even after a sibling fails.
    await Promise.all(Array.from({ length: Math.min(pending.length, this.#policy.submissionConcurrency) }, async () => {
      for (;;) {
        const operation = pending[cursor++];
        if (!operation) return;
        try {
          const provider = this.#providers[operation.request.provider]!;
          const { key: _, ...submission } = operation;
          const result = parseProviderSubmitResult(await withTimeout(signal => provider.submit(freeze(submission), signal), this.#policy.providerTimeoutMs));
          this.#receipts.set(operation.operationId, freeze(result));
        } catch (error) { errors.push(error); }
      }
    }));
    if (errors.length) throw errors[0];
    return prepared.operations.map(op => ({ operationId: op.operationId, result: this.#receipts.get(op.operationId)! }));
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 2048);
}

async function withTimeout<T>(fn: (signal: WorkerAbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Provider request timed out; acceptance is unknown."));
      controller.abort();
    }, ms);
  });
  // DOM and Cloudflare declaration packages describe the same native signal differently.
  try { return await Promise.race([fn(controller.signal as unknown as WorkerAbortSignal), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
