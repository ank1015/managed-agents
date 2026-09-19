import {
  ContractException, jsonEquals, parseEventBody, parseInitializeSessionRequest,
  parseJsonValue, parseSubmitInputRequest,
  parseOperationCompletion, RUNTIME_EVENT_ID_PREFIX, RUNTIME_EVENT_PREFIX,
} from "@managed-agents/contracts";
import type { EventBody, HarnessIdentity, InitializeSessionResult, InputEnvelope, InputReceipt, SessionInfo } from "@managed-agents/contracts";
import type { HarnessContext, HarnessDefinition } from "@managed-agents/harness-api";
import { createContext } from "./context.ts";
import { migrate } from "./migrations.ts";
import { consumeInput, findInput, insertInput, nextInput } from "./storage/inbox.ts";
import { OperationStore } from "./storage/operations.ts";
import type { OperationInfo } from "./storage/operations.ts";
import type { CompletionReceipt, RuntimeEvent } from "@managed-agents/contracts";
import { allocateSequence, findSession, insertSession, requireSession } from "./storage/session.ts";
import type { ProcessNextResult, RuntimeStorage } from "./types.ts";
import { assertSynchronous, assertUndefined, copy, freeze, timestamp } from "./values.ts";
import { operationDefinitions, operationKey } from "./operation-definitions.ts";

/** Synchronous transaction core. Use SessionDriver for automatic delivery and crash-safe wakeups. */
export class SessionRuntime<Config, Input extends EventBody> {
  readonly #storage: RuntimeStorage;
  readonly #harness: HarnessDefinition<Config, Input>;
  readonly #identity: HarnessIdentity;
  readonly #operations: ReadonlySet<string>;
  #busy = false;

  constructor(storage: RuntimeStorage, harness: HarnessDefinition<Config, Input>) {
    this.#storage = storage;
    this.#harness = harness;
    this.#operations = new Set(operationDefinitions(harness.operations).map(operationKey));
    // Reuse the boundary validator for the expected identity too.
    this.#identity = freeze(parseInitializeSessionRequest({
      session: { sessionId: "runtime", harness: harness.identity }, config: null,
    }).session.harness);
    migrate(storage, copy(harness.migrations), () => {
      const existing = findSession(storage.sql);
      if (existing) this.#checkHarness(existing.info.identity.harness);
    });
  }

  initialize(value: unknown): InitializeSessionResult {
    return this.#exclusive(() => {
      const request = parseInitializeSessionRequest(value);
      this.#checkHarness(request.session.harness);
      return this.#storage.transactionSync(() => {
        const existing = findSession(this.#storage.sql);
        if (existing) {
          if (!jsonEquals(parseJsonValue(existing.info.identity), parseJsonValue(request.session))
            || !jsonEquals(existing.originalConfig, request.config)) {
            throw new ContractException("INITIALIZATION_CONFLICT", "Session identity or original configuration differs.");
          }
          return { session: existing.info, duplicate: true };
        }
        const parsed: unknown = this.#harness.parseConfig(copy(request.config));
        assertSynchronous(parsed, "parseConfig");
        const info: SessionInfo = { identity: request.session, config: copy(parseJsonValue(parsed, "INVALID_CONFIG")), createdAt: timestamp() };
        insertSession(this.#storage.sql, info, request.config);
        this.#invoke(info, null, ctx => this.#harness.initialize(ctx), "initialize");
        return { session: info, duplicate: false };
      });
    });
  }

  appendInput(value: unknown): InputReceipt {
    return this.#exclusive(() => {
      const request = parseSubmitInputRequest(value);
      if (request.event.type.startsWith(RUNTIME_EVENT_PREFIX) || request.eventId.startsWith(RUNTIME_EVENT_ID_PREFIX)) {
        throw new ContractException("INVALID_INPUT", "Runtime event types and event IDs are reserved.");
      }
      return this.#storage.transactionSync(() => {
        const { info } = requireSession(this.#storage.sql);
        const existing = findInput(this.#storage.sql, request.eventId);
        if (existing) {
          if (!jsonEquals(parseJsonValue(existing.event), parseJsonValue(request.event))) {
            throw new ContractException("INPUT_CONFLICT", "Event ID was already used for different content.");
          }
          return this.#receipt(info, existing, true);
        }
        const candidate = copy(request.event);
        const parsed: unknown = this.#harness.parseInput(candidate);
        assertSynchronous(parsed, "parseInput");
        const validated = parseEventBody(parsed);
        // Check both the argument and result: validators must not rewrite admitted events.
        if (!jsonEquals(parseJsonValue(candidate), parseJsonValue(request.event))
          || !jsonEquals(parseJsonValue(validated), parseJsonValue(request.event))) {
          throw new ContractException("INVALID_INPUT", "parseInput must preserve event content.");
        }
        const input: InputEnvelope = {
          eventId: request.eventId, event: copy(request.event),
          sequence: allocateSequence(this.#storage.sql), receivedAt: timestamp(),
        };
        insertInput(this.#storage.sql, input);
        return this.#receipt(info, input, false);
      });
    });
  }

  processNext(): ProcessNextResult {
    return this.#exclusive(() => this.#storage.transactionSync(() => {
      const { info } = requireSession(this.#storage.sql);
      const input = nextInput(this.#storage.sql);
      if (!input) return { processed: false };
      // Already validated at admission. Compatible deployments must handle retained inputs.
      this.#invoke(info, input.eventId,
        ctx => this.#harness.handle(freeze(input) as InputEnvelope<Input | RuntimeEvent>, ctx), "handle");
      consumeInput(this.#storage.sql, input.eventId, timestamp());
      return { processed: true, eventId: input.eventId, sequence: input.sequence };
    }));
  }

  getSession(): SessionInfo {
    return this.#exclusive(() => requireSession(this.#storage.sql).info);
  }

  /** Trusted boundary: authenticate the provider in the host before calling this method. */
  acceptCompletion(value: unknown): CompletionReceipt {
    return this.#exclusive(() => {
      requireSession(this.#storage.sql);
      return new OperationStore(this.#storage).accept(parseOperationCompletion(value), timestamp());
    });
  }

  getOperation(operationId: string): OperationInfo {
    return this.#exclusive(() => {
      requireSession(this.#storage.sql);
      return new OperationStore(this.#storage).get(operationId);
    });
  }

  #checkHarness(identity: HarnessIdentity): void {
    if (identity.id !== this.#identity.id || identity.version !== this.#identity.version) {
      throw new ContractException("INITIALIZATION_CONFLICT", "Session harness does not match this runtime.");
    }
  }

  #receipt(info: SessionInfo, input: InputEnvelope, duplicate: boolean): InputReceipt {
    return { sessionId: info.identity.sessionId, eventId: input.eventId, sequence: input.sequence, receivedAt: input.receivedAt, duplicate };
  }

  #invoke(info: SessionInfo, cause: string | null, hook: (ctx: HarnessContext<Config>) => unknown, name: string): void {
    const scope = createContext<Config>(this.#storage.sql, info, cause, this.#operations);
    try { assertUndefined(hook(scope.context), name); }
    finally { scope.close(); }
  }

  #exclusive<T>(operation: () => T): T {
    if (this.#busy) throw new Error("Session runtime methods must not be called reentrantly.");
    this.#busy = true;
    try { return operation(); }
    finally { this.#busy = false; }
  }
}
