import type { EventBody, HarnessIdentity, HarnessStatus, InputEnvelope, JsonValue, OperationDefinition, OperationRequest, RuntimeEvent } from "@managed-agents/contracts";
import type { HarnessInitializationContext, HarnessReadContext, HarnessWriteContext } from "./context.ts";

export interface PlannedOperation extends OperationRequest { key: string }
export interface TransitionPlan<Changes> {
  /** JSON-compatible, in-memory only. Never persisted by the runtime. */
  changes: Changes;
  /** Independent operations; array order does not imply execution order. */
  operations: readonly PlannedOperation[];
  status?: HarnessStatus;
}
export interface HarnessDefinition<Config, Input extends EventBody, Changes = unknown> {
  readonly identity: HarnessIdentity;
  readonly schema: readonly string[];
  readonly operations: readonly Readonly<OperationDefinition>[];
  parseConfig(value: JsonValue): Config;
  parseInput(event: EventBody): Input;
  initialize(ctx: HarnessInitializationContext<Config>): undefined;
  /** Deterministic read-only planning. No promises, writes, random values, or external I/O. */
  handle(input: InputEnvelope<Input | RuntimeEvent>, ctx: HarnessReadContext<Config>): TransitionPlan<Changes>;
  /** Apply the prepared decision synchronously. Runtime owns the transaction and input consumption. */
  apply(changes: Changes, ctx: HarnessWriteContext<Config>): undefined;
}
