import type { EventBody, HarnessIdentity, InputEnvelope, JsonValue, OperationDefinition, RuntimeEvent } from "@managed-agents/contracts";
import type { HarnessContext } from "./context.ts";
import type { SqlMigration } from "./migrations.ts";

export interface HarnessDefinition<Config, Input extends EventBody> {
  readonly identity: HarnessIdentity;
  readonly migrations: readonly SqlMigration[];
  /** Exact provider/type/version combinations this harness may request. The host supplies adapters. */
  readonly operations: readonly Readonly<OperationDefinition>[];

  /** Synchronous, state-independent validation; returned defaults must remain JSON-compatible. */
  parseConfig(value: JsonValue): Config;
  /** Validate supported event shapes without rewriting content or consulting session state. */
  parseInput(event: EventBody): Input;

  /** Initial state commits once; uncommitted attempts may retry. Throw to roll back. */
  initialize(ctx: HarnessContext<Config>): undefined;
  /** One admitted input per transaction. No promises, external I/O, or retained context. */
  handle(input: InputEnvelope<Input | RuntimeEvent>, ctx: HarnessContext<Config>): undefined;
}
