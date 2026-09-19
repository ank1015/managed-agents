import type { AbortSignal as WorkerAbortSignal, DurableObjectStorage } from "@cloudflare/workers-types";
import {
  parseInitializeSessionRequest, parseOperationCompletion, parseSubmitInputRequest,
  parseProviderStatusResult, parseProviderSubmitResult,
} from "@managed-agents/contracts";
import type { EventBody, CompletionReceipt, InitializeSessionResult, InputReceipt, SessionInfo } from "@managed-agents/contracts";
import type { HarnessDefinition } from "@managed-agents/harness-api";
import type { ProviderRegistry } from "./provider.ts";
import { SessionRuntime } from "./runtime.ts";
import { OperationStore } from "./storage/operations.ts";
import type { DeliveryAction, OperationInfo } from "./storage/operations.ts";
import { failProcessing, processingStatus, resetProcessing } from "./storage/progress.ts";
import type { ProcessingStatus } from "./storage/progress.ts";
import { findSession } from "./storage/session.ts";
import { copy, freeze } from "./values.ts";
import { operationDefinitions } from "./operation-definitions.ts";
import type { RuntimeStorage } from "./types.ts";

export type DriverStorage = RuntimeStorage & Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">;

export interface DriverPolicy {
  maxSteps: number;
  maxSliceMs: number;
  providerTimeoutMs: number;
  attemptLeaseMs: number;
  recoveryMs: number;
  continuationMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  reconcileMs: number;
  maxHandlerFailures: number;
}

export const DEFAULT_DRIVER_POLICY: Readonly<DriverPolicy> = Object.freeze({
  maxSteps: 32, maxSliceMs: 250, providerTimeoutMs: 10_000, attemptLeaseMs: 15_000,
  recoveryMs: 30_000, continuationMs: 1, retryBaseMs: 500, retryMaxMs: 60_000,
  reconcileMs: 30_000, maxHandlerFailures: 5,
});

export interface SessionDriverOptions {
  providers: ProviderRegistry;
  /** Bind to DurableObjectState.waitUntil. Called for prompt progress after admission. */
  waitUntil(promise: Promise<void>): void;
  policy?: Partial<DriverPolicy>;
}

/** One driver per DO. The host must forward alarm() and use these admission methods.
 * The synchronous core remains available independently for manual Step 1 diagnostics. */
export class SessionDriver<Config, Input extends EventBody> {
  readonly #storage: DriverStorage;
  readonly #runtime: SessionRuntime<Config, Input>;
  readonly #operations: OperationStore;
  readonly #providers: ProviderRegistry;
  readonly #waitUntil: SessionDriverOptions["waitUntil"];
  readonly #policy: Readonly<DriverPolicy>;
  #queue: Promise<unknown> = Promise.resolve();
  #running: Promise<void> | undefined;
  #requested = false;

  constructor(storage: DriverStorage, harness: HarnessDefinition<Config, Input>, options: SessionDriverOptions) {
    const policy = { ...DEFAULT_DRIVER_POLICY, ...options.policy };
    for (const [name, value] of Object.entries(policy)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`Invalid driver policy: ${name}.`);
    }
    if (policy.attemptLeaseMs <= policy.providerTimeoutMs) throw new Error("attemptLeaseMs must exceed providerTimeoutMs.");
    if (policy.retryMaxMs < policy.retryBaseMs) throw new Error("retryMaxMs must be >= retryBaseMs.");
    for (const { provider } of operationDefinitions(harness.operations)) {
      const adapter = Object.hasOwn(options.providers, provider) ? options.providers[provider] : undefined;
      if (!adapter || typeof adapter.submit !== "function" || typeof adapter.get !== "function") {
        throw new Error(`Provider is not configured for declared harness operations: ${provider}`);
      }
    }
    this.#storage = storage;
    this.#runtime = new SessionRuntime(storage, harness);
    this.#operations = new OperationStore(storage);
    this.#providers = Object.freeze({ ...options.providers });
    this.#waitUntil = options.waitUntil;
    this.#policy = Object.freeze(policy);
  }

  async initialize(value: unknown): Promise<InitializeSessionResult> {
    const request = copy(parseInitializeSessionRequest(value));
    return this.#admit(() => this.#runtime.initialize(request));
  }

  async appendInput(value: unknown): Promise<InputReceipt> {
    const request = copy(parseSubmitInputRequest(value));
    return this.#admit(() => this.#runtime.appendInput(request));
  }

  /** Host authenticates this provider; never expose this as ordinary user input. */
  async acceptCompletion(value: unknown): Promise<CompletionReceipt> {
    const completion = copy(parseOperationCompletion(value));
    return this.#admit(() => this.#runtime.acceptCompletion(completion));
  }

  getSession(): SessionInfo { return this.#runtime.getSession(); }
  getOperation(id: string): OperationInfo { return this.#runtime.getOperation(id); }
  getProcessingStatus(): ProcessingStatus { return processingStatus(this.#storage.sql); }

  /** Retry the retained head input after fixing the harness/configuration. Never skips it. */
  async resumeProcessing(): Promise<void> {
    await this.#admit(() => {
      this.#runtime.getSession();
      resetProcessing(this.#storage.sql);
    });
  }

  /** Forward every DO alarm, including duplicates. Re-arm even when joining a running slice:
   * entering an alarm consumes the previously scheduled wakeup. */
  async alarm(): Promise<void> {
    await this.#locked(() => this.#arm());
    await this.run();
  }

  /** A bounded progress slice; concurrent callers join it. Usually invoked via waitUntil/alarm. */
  run(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      if (this.#requested) {
        this.#requested = false;
        this.#kick();
      }
    });
    return this.#running;
  }

  #kick(): void {
    if (this.#running) { this.#requested = true; return; }
    this.#waitUntil(this.run());
  }

  async #admit<T>(commit: () => T): Promise<T> {
    const result = await this.#locked(async () => {
      // Crash before commit leaves a harmless extra alarm; crash after commit leaves a wakeup.
      // No network is awaited under this lock. Alarm clearing uses the same lock.
      await this.#arm();
      return commit();
    });
    this.#kick();
    return result;
  }

  #locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #arm(): Promise<void> {
    const due = Date.now() + this.#policy.recoveryMs;
    const existing = await this.#storage.getAlarm();
    if (existing === null || existing > due) await this.#storage.setAlarm(due);
  }

  #backoff(attempt: number): number {
    const cap = Math.min(this.#policy.retryMaxMs, this.#policy.retryBaseMs * 2 ** Math.min(30, attempt - 1));
    // Bounded jitter keeps many recovering sessions from retrying in lockstep.
    return Math.max(1, Math.round(cap * (0.5 + Math.random() * 0.5)));
  }

  async #drain(): Promise<void> {
    await this.#locked(() => this.#arm());
    const started = Date.now();
    for (let step = 0; step < this.#policy.maxSteps && Date.now() - started < this.#policy.maxSliceMs; step++) {
      const work = await this.#locked(() => {
        if (!findSession(this.#storage.sql)) return { processed: false, action: undefined };
        const now = Date.now();
        const progress = processingStatus(this.#storage.sql);
        let processed = false;
        if (progress.pendingEventId !== null && !progress.blocked && (progress.retryAt === null || progress.retryAt <= now)) {
          try {
            processed = this.#runtime.processNext().processed;
            resetProcessing(this.#storage.sql);
          } catch (error) {
            // The transition rolled back; persist its retry state in a separate write.
            failProcessing(this.#storage.sql, progress, now + this.#backoff(progress.failures + 1),
              this.#policy.maxHandlerFailures, errorMessage(error));
          }
        }
        return { processed, action: this.#operations.claim(now, this.#policy.attemptLeaseMs) };
      });
      if (work.action) await this.#deliver(work.action);
      if (!work.processed && !work.action) break;
    }
    // The snapshot and alarm update share the admission lock, so a concurrent input cannot
    // be committed between an idle snapshot and deleteAlarm (or a later setAlarm).
    await this.#locked(async () => {
      const progress = processingStatus(this.#storage.sql);
      const inboxDue = progress.pendingEventId !== null && !progress.blocked ? progress.retryAt ?? Date.now() : null;
      const operationDue = this.#operations.nextDeadline();
      const due = inboxDue === null ? operationDue : operationDue === null ? inboxDue : Math.min(inboxDue, operationDue);
      if (due === null) await this.#storage.deleteAlarm();
      else await this.#storage.setAlarm(Math.max(Date.now() + this.#policy.continuationMs, due));
    });
  }

  async #deliver(action: DeliveryAction): Promise<void> {
    try {
      const provider = Object.hasOwn(this.#providers, action.provider) ? this.#providers[action.provider] : undefined;
      if (!provider) throw new Error(`Provider is not configured: ${action.provider}`);
      if (action.kind === "submit") {
        const result = copy(parseProviderSubmitResult(await withTimeout(signal => provider.submit(freeze({
          operationId: action.operationId, submissionId: action.submissionId, request: action.request,
        }), signal), this.#policy.providerTimeoutMs)));
        await this.#locked(() => this.#operations.submitted(action, result, Date.now(), this.#policy.reconcileMs));
      } else {
        const result = copy(parseProviderStatusResult(await withTimeout(signal => provider.get(freeze({
          operationId: action.operationId, submissionId: action.submissionId, jobId: action.jobId,
        }), signal), this.#policy.providerTimeoutMs)));
        await this.#locked(() => this.#operations.reconciled(action, result, Date.now(), this.#policy.reconcileMs));
      }
    } catch (error) {
      // This includes ambiguous timeouts and malformed responses. Neither proves rejection.
      await this.#locked(() => this.#operations.retry(action, Date.now() + this.#backoff(action.attempt), errorMessage(error)));
    }
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
