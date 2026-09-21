import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContractException,
  jsonEquals,
  parseCreateSessionRequest,
  parseSessionCommand,
  parseEventBody,
  parseInitializeSessionRequest,
  parseJsonValue,
  parseSubmitInputRequest,
} from "@managed-agents/contracts";
import type { ContractErrorCode, JsonValue } from "@managed-agents/contracts";

function rejects(code: ContractErrorCode, run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof ContractException && error.code === code);
}

test("JSON validation preserves valid data without coercing or cloning", () => {
  const shared = { text: "hello" };
  const value = { a: shared, b: shared, values: [null, true, false, 1.5, ""] };
  assert.equal(parseJsonValue(value), value);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assert.equal(parseJsonValue(Object.create(null) as unknown) !== undefined, true);
});

test("JSON validation rejects data that JSON would discard or rewrite", () => {
  class Config { label = "hidden class"; }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() { throw new Error("Getter must not run"); },
  });
  const invalid: unknown[] = [
    undefined, NaN, Infinity, -Infinity, 1n, Symbol("x"), () => {},
    new Date(), new Map(), new Set(), new Config(), new Uint8Array([1]),
    { nested: { missing: undefined } }, [undefined], new Array(2),
    Object.assign([1], { extra: 2 }),
    Object.defineProperty({}, "hidden", { value: 1 }),
    { [Symbol("hidden")]: 1 }, accessor, cycle,
    { toJSON() { throw new Error("toJSON must not run"); } },
  ];
  for (const value of invalid) rejects("INVALID_REQUEST", () => parseJsonValue(value));
  rejects("INVALID_CONFIG", () => parseJsonValue({ value: undefined }, "INVALID_CONFIG"));
});

test("JSON comparison ignores object key order but preserves arrays and values", () => {
  const pairs: [JsonValue, JsonValue, boolean][] = [
    [{ a: 1, nested: { b: 2, c: 3 } }, { nested: { c: 3, b: 2 }, a: 1 }, true],
    [[1, 2], [2, 1], false],
    [[1], [1, 2], false],
    [{ a: 1 }, { a: 1, b: null }, false],
    [{ a: null }, { b: null }, false],
    [1, "1", false],
    [null, {}, false],
    [[], {}, false],
    [-0, 0, true],
    [JSON.parse('{"__proto__":{"value":1}}') as JsonValue, {}, false],
  ];
  for (const [left, right, expected] of pairs) {
    assert.equal(jsonEquals(left, right), expected);
    assert.equal(jsonEquals(right, left), expected);
  }
});

test("session creation requires object metadata and preserves arbitrary JSON fields", () => {
  const value = { requestId: "create-1", harness: { id: "fixture", version: "v1" },
    config: {}, metadata: { title: "Example", tags: ["one", "two"], nested: { pinned: true } } };
  assert.deepEqual(parseCreateSessionRequest(value), value);
  rejects("INVALID_REQUEST", () => parseCreateSessionRequest({ ...value, execution: { token: "removed" } }));
  rejects("INVALID_REQUEST", () => parseSessionCommand({ action: "updateExecution", value: { token: "removed" } }));
  for (const metadata of [undefined, null, [], "metadata", 1]) {
    rejects("INVALID_REQUEST", () => parseCreateSessionRequest({ ...value, metadata }));
  }
});

const initialization = {
  session: {
    sessionId: "session-1",
    harness: { id: "fixture", version: "v1" },
  },
  config: { label: "test" },
};

test("initialization preserves identity and leaves config semantics to the harness", () => {
  assert.deepEqual(parseInitializeSessionRequest(initialization), initialization);
  assert.equal(parseInitializeSessionRequest({ ...initialization, config: null }).config, null);
  const request = { ...initialization, config: { arbitrary: [1, 2] } };
  assert.deepEqual(parseInitializeSessionRequest(request).config, request.config);
});

test("initialization rejects missing identity, malformed config, and runtime-owned fields", () => {
  for (const value of [
    null,
    {},
    { session: initialization.session },
    { ...initialization, config: undefined },
    { ...initialization, createdAt: 123 },
    { ...initialization, session: { ...initialization.session, sessionId: 1 } },
    { ...initialization, session: { ...initialization.session, harness: { id: "fixture" } } },
    { ...initialization, session: { ...initialization.session, extra: true } },
  ]) {
    rejects("INVALID_REQUEST", () => parseInitializeSessionRequest(value));
  }
});

test("input admission accepts a generic event without imposing a harness schema", () => {
  const value = {
    eventId: "input-1",
    event: { type: "fixture.record", payload: { text: "hello" } },
  };
  assert.deepEqual(parseSubmitInputRequest(value), value);
  assert.deepEqual(parseEventBody({ type: "fixture.empty", payload: null }), {
    type: "fixture.empty", payload: null,
  });
});

test("producer cannot supply runtime admission metadata", () => {
  const value = { eventId: "input-1", event: { type: "fixture.record", payload: null } };
  for (const extra of [{ sequence: 1 }, { receivedAt: 1 }, { consumedAt: 1 }]) {
    rejects("INVALID_REQUEST", () => parseSubmitInputRequest({ ...value, ...extra }));
  }
  rejects("INVALID_REQUEST", () => parseSubmitInputRequest({ ...value, eventId: "" }));
});

test("event body validation distinguishes invalid event content", () => {
  for (const event of [null, {}, { type: "event" }, { type: " ", payload: null },
    { type: "event", payload: undefined }, { type: "event", payload: null, extra: 1 }]) {
    rejects("INVALID_INPUT", () => parseEventBody(event));
  }
  rejects("INVALID_INPUT", () => parseSubmitInputRequest({ eventId: "input-1", event: {} }));
});

test("expected errors serialize to the wire shape without a stack", () => {
  const error = new ContractException("INPUT_CONFLICT", "Input identity is already used.");
  assert.ok(error instanceof Error);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), {
    code: "INPUT_CONFLICT", message: "Input identity is already used.",
  });
});
