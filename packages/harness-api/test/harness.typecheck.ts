import type { SqlStorage } from "@cloudflare/workers-types";
import type { EventBody, InputEnvelope, SessionIdentity } from "@managed-agents/contracts";
import type { HarnessReadContext, HarnessDefinition, TransitionPlan } from "@managed-agents/harness-api";
interface Config { label: string }
type Input = { type: "fixture.record"; payload: { text: string } };
type FixtureHarness = HarnessDefinition<Config, Input, { text: string }>;
const harness: FixtureHarness = {
  identity: { id: "fixture", version: "v1" }, operations: [],
  schema: ["CREATE TABLE counter (text TEXT)"],
  parseConfig: () => ({ label: "test" }), parseInput: event => event as Input,
  initialize(ctx) {
    // @ts-expect-error Initialization cannot dispatch operations.
    ctx.requestOperation({});
    // @ts-expect-error The API, not initialization, publishes idle.
    ctx.setStatus("idle");
  },
  handle(input, ctx) {
    const text = input.event.type === "runtime.operation.completed" ? input.event.payload.operationId : input.event.payload.text;
    return { changes: { text }, operations: [], status: "running" };
  },
  apply(changes, ctx) { ctx.sql.exec("INSERT INTO counter VALUES (?)", changes.text); },
};
declare const sql: SqlStorage;
declare const session: SessionIdentity;
const ctx: HarnessReadContext<Config> = { session, config: { label: "test" }, sql, operationId: key => key };
const rows: { text: string }[] = ctx.sql.exec<{ text: string }>("SELECT text FROM counter").toArray();
const id: string = ctx.operationId("llm");
// @ts-expect-error Async handlers cannot satisfy the deterministic synchronous planning contract.
const asyncHandler: FixtureHarness["handle"] = async () => ({ changes: { text: "" }, operations: [] });
// @ts-expect-error Apply must remain a synchronous local transaction.
const asyncApply: FixtureHarness["apply"] = async () => {};
// @ts-expect-error Initialization cannot return a promise either.
const asyncInitialization: FixtureHarness["initialize"] = async () => {};
// @ts-expect-error Dispatch is returned as a plan, not performed through the context.
ctx.requestOperation({ provider: "echo", type: "echo", version: "v1", input: null });
// @ts-expect-error Status is returned in the transition, not a context side effect.
ctx.setStatus("running");
// @ts-expect-error Every outgoing operation needs a stable key.
const invalid: TransitionPlan<null> = { changes: null, operations: [{ provider: "echo", type: "echo", version: "v1", input: null }] };
// @ts-expect-error Creation lifecycle is controlled by the API, not the harness.
const creation: TransitionPlan<null> = { changes: null, operations: [], status: "initializing" };
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
