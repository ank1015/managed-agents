import {
  ContractException, HARNESS_STATUSES, jsonEquals, parseEventBody, parseInitializeSessionRequest,
  parseJsonValue, parseSubmitInputRequest, parseOperationCompletion, parseOperationRequest, parseProviderSubmitResult,
  RUNTIME_EVENT_ID_PREFIX, RUNTIME_EVENT_PREFIX,
} from "@managed-agents/contracts";
import type { EventBody, HarnessIdentity, InputEnvelope, InputReceipt, SessionInfo, InitializeSessionResult,
  CompletionReceipt, RuntimeEvent, OperationCompletion, OperationOutcome, ProviderSubmitResult } from "@managed-agents/contracts";
import type { HarnessDefinition } from "@managed-agents/harness-api";
import { createReadContext, createInitializationContext } from "./context.ts";
import { bootstrap } from "./bootstrap.ts";
import { allocateSequence, consumeInput, findInput, insertInput, nextInput } from "./storage/inbox.ts";
import { PendingOperations } from "./storage/operations.ts";
import { findSession, insertSession } from "./storage/session.ts";
import type { ProcessNextResult, RuntimeStorage, PreparedTransition, SubmissionReceipt } from "./types.ts";
import { assertSynchronous, assertUndefined, copy, freeze, timestamp } from "./values.ts";
import { operationDefinitions, operationKey } from "./operation-definitions.ts";
import { operationId, operationIdentity } from "./operation-identity.ts";
import { inputHash } from "./input-hash.ts";

/** Read-only deterministic preparation and atomic local commit. No outgoing payload persistence. */
export class SessionRuntime<Config, Input extends EventBody, Changes = unknown> {
  readonly #storage: RuntimeStorage;
  readonly #harness: HarnessDefinition<Config, Input, Changes>;
  readonly #identity: HarnessIdentity;
  readonly #operations: ReadonlySet<string>;
  #session: SessionInfo | undefined;
  #busy = false;
  #prepared: PreparedTransition<Changes> | undefined;

  constructor(storage: RuntimeStorage, harness: HarnessDefinition<Config, Input, Changes>) {
    this.#storage = storage;
    this.#harness = harness;
    this.#operations = new Set(operationDefinitions(harness.operations).map(operationKey));
    // Reuse the boundary validator for the expected identity too.
    this.#identity = freeze(parseInitializeSessionRequest({
      session: { sessionId: "runtime", harness: harness.identity }, config: null,
    }).session.harness);
    bootstrap(storage, harness.schema);
    const existing = findSession(storage.sql);
    if (existing) {
      this.#checkHarness(existing.info.identity.harness);
      this.#session = freeze(existing.info);
    }
  }

  get initialized(): boolean { return this.#loadSession() !== undefined; }
  /** Diagnostic identity only; never loads storage or copies conversation config. */
  get cachedSessionId(): string | undefined { return this.#session?.identity.sessionId; }

  initialize(value: unknown): InitializeSessionResult {
    return this.#exclusive(() => {
      const request = parseInitializeSessionRequest(value);
      this.#checkHarness(request.session.harness);
      const result = this.#storage.transactionSync(() => {
        const existing = this.#loadSession();
        if (existing) {
          // The API checks creation-content hashes before this trusted RPC. Never
          // re-resolve defaults or overwrite config on a duplicate initialization.
          if (!jsonEquals(parseJsonValue(existing.identity), parseJsonValue(request.session))) {
            throw new ContractException("INITIALIZATION_CONFLICT", "Session identity differs.");
          }
          return { session: existing, duplicate: true };
        }
        const parsed: unknown = this.#harness.parseConfig(copy(request.config));
        assertSynchronous(parsed, "parseConfig");
        const info: SessionInfo = freeze({ identity: request.session, config: copy(parseJsonValue(parsed, "INVALID_CONFIG")), createdAt: timestamp() });
        insertSession(this.#storage.sql, info);
        const scope = createInitializationContext<Config>(this.#storage.sql, info);
        try { assertUndefined(this.#harness.initialize(scope.context), "initialize"); }
        finally { scope.close(); }
        return { session: info, duplicate: false };
      });
      // Never publish a cache entry before both initialization hooks and commit succeed.
      this.#session = result.session;
      return { ...result, session: copy(result.session) };
    });
  }

  appendInput(value: unknown): InputReceipt {
    return this.prepareInput(value)();
  }

  /** Validate/snapshot once before an asynchronous admission lock. The returned
   * closure owns the immutable request; commit still checks durable deduplication. */
  prepareInput(value: unknown): () => InputReceipt {
    const request = freeze(copy(parseSubmitInputRequest(value)));
    const hash = inputHash(request.event);
    return () => this.#exclusive(() => {
      if (request.event.type.startsWith(RUNTIME_EVENT_PREFIX) || request.eventId.startsWith(RUNTIME_EVENT_ID_PREFIX)) {
        throw new ContractException("INVALID_INPUT", "Runtime event types and event IDs are reserved.");
      }
      return this.#storage.transactionSync(() => {
        const info = this.#requireSession();
        const existing = findInput(this.#storage.sql, request.eventId);
        if (existing) {
          if (existing.hash !== hash) {
            throw new ContractException("INPUT_CONFLICT", "Event ID was already used for different content.");
          }
          return this.#receipt(info, existing, true);
        }
        const parsed: unknown = this.#harness.parseInput(request.event);
        assertSynchronous(parsed, "parseInput");
        const validated = parseEventBody(parsed);
        // The argument is immutable; the validator must also return the same content.
        if (validated.type !== request.event.type || !jsonEquals(validated.payload, request.event.payload)) {
          throw new ContractException("INVALID_INPUT", "parseInput must preserve event content.");
        }
        const input: InputEnvelope = {
          eventId: request.eventId, event: request.event,
          sequence: allocateSequence(this.#storage.sql), receivedAt: timestamp(),
        };
        insertInput(this.#storage.sql, input, hash);
        return this.#receipt(info, input, false);
      });
    });
  }


  prepareNext(): PreparedTransition<Changes> | undefined {
    return this.#exclusive(() => this.#prepare());
  }

  #prepare(): PreparedTransition<Changes> | undefined {
    const info = this.#requireSession();
    if (this.#prepared) return this.#prepared;
    const input = nextInput(this.#storage.sql);
    if (!input) return;
    if (input.event.type === "runtime.operation.completed") {
      const completion = input.event as RuntimeEvent;
      const { operationId: id, provider, jobId, outcome } = completion.payload;
      if (!(outcome.status === "failed" && outcome.origin === "submission")) {
        const pending = new PendingOperations(this.#storage.sql).find(id);
        if (!pending || pending.provider !== provider || pending.jobId !== jobId) {
          throw new ContractException("COMPLETION_CONFLICT", "Completion does not match its committed acceptance.");
        }
      }
    }
    const scope = createReadContext<Config>(this.#storage.sql, info, input.sequence);
    try {
      const plan = this.#harness.handle(freeze(input) as InputEnvelope<Input | RuntimeEvent>, scope.context);
      assertSynchronous(plan, "handle");
      if (!plan || typeof plan !== "object" || Array.isArray(plan) || !Array.isArray(plan.operations)
        || !Object.hasOwn(plan, "changes") || Object.keys(plan).some(key => !["changes", "operations", "status"].includes(key))) {
        throw new Error("handle must return a transition plan with changes and operations.");
      }
      parseJsonValue(plan.changes);
      if (plan.status !== undefined && !HARNESS_STATUSES.includes(plan.status)) throw new Error("Invalid harness status.");
      const keys = new Set<string>();
      const operations = plan.operations.map(op => {
        const id = operationId(info.identity, input.sequence, op.key);
        if (keys.has(op.key)) throw new Error("Duplicate operation key in transition.");
        keys.add(op.key);
        const { key, ...value } = op;
        const request = parseOperationRequest(value);
        if (!this.#operations.has(operationKey(request))) {
          throw new ContractException("INVALID_REQUEST", "Harness has not declared this operation.");
        }
        // Both wire fields intentionally share one derived identity; no independent submission ID/state.
        return { key, operationId: id, submissionId: id, request };
      });
      this.#prepared = freeze({ input, changes: plan.changes, operations,
        ...(plan.status === undefined ? {} : { status: plan.status }) });
      return this.#prepared;
    } finally { scope.close(); }
  }

  commit(prepared: PreparedTransition<Changes>, receipts: readonly SubmissionReceipt[]): ProcessNextResult {
    return this.#exclusive(() => {
      if (prepared !== this.#prepared) throw new Error("Transition does not belong to this runtime.");
      const results = new Map<string, ProviderSubmitResult>();
      for (const receipt of receipts) {
        if (results.has(receipt.operationId) || !prepared.operations.some(op => op.operationId === receipt.operationId)) {
          throw new Error("Invalid or duplicate submission receipt.");
        }
        results.set(receipt.operationId, parseProviderSubmitResult(receipt.result));
      }
      if (results.size !== prepared.operations.length) throw new Error("Every submission must be resolved before commit.");
      const info = this.#requireSession();
      const result = this.#storage.transactionSync(() => {
        const head = this.#storage.sql.exec<{ event_id: string }>(
          "SELECT event_id FROM runtime_inbox WHERE consumed_at IS NULL ORDER BY sequence LIMIT 1").toArray()[0];
        if (head?.event_id !== prepared.input.eventId) throw new Error("Transition is no longer the inbox head.");
        const scope = createInitializationContext<Config>(this.#storage.sql, info);
        try { assertUndefined(this.#harness.apply(prepared.changes, scope.context), "apply"); }
        finally { scope.close(); }
        const pending = new PendingOperations(this.#storage.sql);
        for (const op of prepared.operations) {
          const receipt = results.get(op.operationId)!;
          if (receipt.status === "rejected") {
            this.#queueCompletion(op.operationId, op.request.provider, null,
              { status: "failed", origin: "submission", error: receipt.error });
          } else {
            pending.insert(op.operationId, prepared.input.sequence, op.key, op.request.provider, receipt.jobId);
            if (receipt.status === "completed") this.#queueCompletion(op.operationId, op.request.provider, receipt.jobId, receipt.outcome);
          }
        }
        if (prepared.input.event.type === "runtime.operation.completed") {
          pending.delete((prepared.input.event as RuntimeEvent).payload.operationId);
        }
        consumeInput(this.#storage.sql, prepared.input, timestamp());
        return { processed: true as const, eventId: prepared.input.eventId, sequence: prepared.input.sequence,
          ...(prepared.status === undefined ? {} : { status: prepared.status }) };
      });
      this.#prepared = undefined;
      return result;
    });
  }

  getSession(): SessionInfo { return this.#exclusive(() => copy(this.#requireSession())); }
  getPendingOperations() { return new PendingOperations(this.#storage.sql).list(); }

  /** Authenticated worker boundary. Early completions queue behind their initiating input. */
  acceptCompletion(value: unknown): CompletionReceipt {
    return this.prepareCompletion(value)().commit();
  }

  /** Snapshot and validate once before the driver's admission lock. Check and
   * commit must share that lock, including any intervening alarm await. */
  prepareCompletion(value: unknown): () => { consumed: boolean; commit(): CompletionReceipt } {
    const completion = freeze(copy(parseOperationCompletion(value)));
    const event = this.#completionEvent(completion.operationId, completion.provider, completion.jobId, completion.outcome);
    const id = this.#completionEventId(completion.operationId), hash = inputHash(event);
    return () => this.#exclusive(() => {
      this.#requireSession();
      const identity = operationIdentity(completion.operationId);
      if (completion.submissionId !== completion.operationId) {
        throw new ContractException("COMPLETION_CONFLICT", "Submission identity must equal the derived operation identity.");
      }
      const existing = findInput(this.#storage.sql, id);
      if (existing) {
        if (existing.hash !== hash) throw new ContractException("COMPLETION_CONFLICT", "Completion content changed.");
        return { consumed: existing.consumed, commit: () => ({ operationId: completion.operationId, eventId: id, duplicate: true }) };
      }
      const pending = new PendingOperations(this.#storage.sql).find(completion.operationId);
      if (pending) {
        if (pending.provider !== completion.provider || pending.jobId !== completion.jobId) {
          throw new ContractException("COMPLETION_CONFLICT", "Completion differs from accepted provider/job.");
        }
      } else {
        // On activation loss, recompute the still-unconsumed input. No network or writes during preparation.
        const prepared = this.#prepare();
        const operation = prepared?.operations.find(op => op.operationId === completion.operationId);
        if (!prepared || prepared.input.sequence !== identity.sequence || !operation || operation.request.provider !== completion.provider) {
          throw new ContractException("OPERATION_NOT_FOUND", "Completion has no pending or prepared operation.");
        }
      }
      let used = false;
      return { consumed: false, commit: () => this.#exclusive(() => {
        if (used) throw new Error("Completion admission already committed.");
        used = true;
        return this.#storage.transactionSync(() => {
          insertInput(this.#storage.sql, { eventId: id, sequence: allocateSequence(this.#storage.sql), receivedAt: timestamp(), event }, hash);
          return { operationId: completion.operationId, eventId: id, duplicate: false };
        });
      }) };
    });
  }

  #completionEventId(id: string): string { return `${RUNTIME_EVENT_ID_PREFIX}operation:${id}`; }
  #completionEvent(id: string, provider: string, jobId: string | null, outcome: OperationOutcome): RuntimeEvent {
    return { type: "runtime.operation.completed", payload: { operationId: id, provider, jobId, outcome } };
  }
  #queueCompletion(id: string, provider: string, jobId: string | null, outcome: OperationOutcome): CompletionReceipt {
    const eventId = this.#completionEventId(id), event = this.#completionEvent(id, provider, jobId, outcome);
    const hash = inputHash(event), existing = findInput(this.#storage.sql, eventId);
    if (existing) {
      if (existing.hash !== hash) throw new ContractException("COMPLETION_CONFLICT", "Completion content changed.");
      return { operationId: id, eventId, duplicate: true };
    }
    insertInput(this.#storage.sql, { eventId, sequence: allocateSequence(this.#storage.sql), receivedAt: timestamp(), event }, hash);
    return { operationId: id, eventId, duplicate: false };
  }

  #checkHarness(identity: HarnessIdentity): void {
    if (identity.id !== this.#identity.id || identity.version !== this.#identity.version) {
      throw new ContractException("INITIALIZATION_CONFLICT", "Session harness does not match this runtime.");
    }
  }

  #requireSession(): SessionInfo {
    const session = this.#loadSession();
    if (!session) throw new ContractException("SESSION_NOT_INITIALIZED", "Initialize the session first.");
    return session;
  }

  #loadSession(): SessionInfo | undefined {
    // Do not negatively cache absence: another runtime sharing this storage may
    // initialize it. Once present, identity/config are immutable for the namespace.
    if (!this.#session) {
      const existing = findSession(this.#storage.sql);
      if (existing) {
        this.#checkHarness(existing.info.identity.harness);
        this.#session = freeze(existing.info);
      }
    }
    return this.#session;
  }

  #receipt(info: SessionInfo, input: Pick<InputEnvelope, "eventId" | "sequence" | "receivedAt">, duplicate: boolean): InputReceipt {
    return { sessionId: info.identity.sessionId, eventId: input.eventId, sequence: input.sequence, receivedAt: input.receivedAt, duplicate };
  }

  #exclusive<T>(operation: () => T): T {
    if (this.#busy) throw new Error("Session runtime methods must not be called reentrantly.");
    this.#busy = true;
    try { return operation(); }
    finally { this.#busy = false; }
  }
}
