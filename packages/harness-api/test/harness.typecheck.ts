import type { SqlStorage } from "@cloudflare/workers-types";
import type { EventBody, InputEnvelope, SessionIdentity } from "@managed-agents/contracts";
import { ContractException } from "@managed-agents/contracts";
import type { HarnessContext, HarnessDefinition } from "@managed-agents/harness-api";

interface Config { label: string }
type Input = { type: "fixture.record"; payload: { text: string } };
type FixtureHarness = HarnessDefinition<Config, Input>;

const harness: FixtureHarness = {
  identity: { id: "fixture", version: "v1" },
  operations: [],
  migrations: [{ version: 1, statements: ["CREATE TABLE counter (value INTEGER)"] }],
  parseConfig(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.label !== "string") {
      throw new ContractException("INVALID_CONFIG", "label is required.");
    }
    return { label: value.label };
  },
  parseInput(event) {
    const payload = event.payload;
    if (event.type !== "fixture.record" || payload === null || typeof payload !== "object" || Array.isArray(payload) || typeof payload.text !== "string") {
      throw new ContractException("INVALID_INPUT", "Expected fixture.record with text.");
    }
    return event as Input;
  },
  initialize(ctx) {
    ctx.sql.exec("INSERT INTO counter (value) VALUES (?)", 0);
  },
  handle(input, ctx) {
    if (input.event.type === "runtime.operation.completed") {
      const id: string = input.event.payload.operationId;
      return;
    }
    const text: string = input.event.payload.text;
    ctx.sql.exec("UPDATE counter SET value = value + 1");
  },
};

declare const sql: SqlStorage;
declare const session: SessionIdentity;
const ctx: HarnessContext<Config> = {
  session,
  config: { label: "test" },
  sql,
  requestOperation() { return "operation-1"; },
};

// The actual Cloudflare SQL interface remains directly usable with typed cursors.
const rows: { value: number }[] = ctx.sql.exec<{ value: number }>("SELECT value FROM counter").toArray();

// @ts-expect-error Async handlers cannot satisfy the synchronous transition contract.
const asyncHandler: FixtureHarness["handle"] = async () => {};
// @ts-expect-error Initialization cannot return a promise either.
const asyncInitialization: FixtureHarness["initialize"] = async () => {};
// @ts-expect-error Operation requests require an explicit version and JSON input.
ctx.requestOperation({ provider: "echo", type: "echo" });
const operationId: string = ctx.requestOperation({ provider: "echo", type: "echo", version: "v1", input: null });
// @ts-expect-error State is persisted through the context, not returned as a new state object.
const returningState: FixtureHarness["handle"] = () => ({ count: 1 });
// @ts-expect-error Config validation must also be synchronous.
const asyncConfig: FixtureHarness["parseConfig"] = async () => ({ label: "test" });
// @ts-expect-error Config properties are readonly during a transition.
ctx.config.label = "changed";
// @ts-expect-error The context does not expose transaction ownership.
ctx.sql.transactionSync(() => {});
// @ts-expect-error Undefined cannot silently enter the persisted event payload.
const invalidBody: EventBody = { type: "bad", payload: undefined };
// @ts-expect-error Inputs must include the runtime-assigned sequence and timestamp.
const unadmittedInput: InputEnvelope<Input> = { eventId: "input-1", event: { type: "fixture.record", payload: { text: "hello" } } };
