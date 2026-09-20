import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionCommand, parseSubmitInputRequest } from "../src/index.ts";

test("structured commands preserve payloads for one action-specific boundary validation", () => {
  const input = { eventId: "one", event: { type: "message", payload: { content: "hello" } } };
  const command = parseSessionCommand({ action: "appendInput", value: input });
  assert.equal("value" in command && command.value, input);
  assert.deepEqual(parseSubmitInputRequest(input), input);
  const malformed = { ...input, unwanted: true };
  const forwarded = parseSessionCommand({ action: "appendInput", value: malformed });
  assert.throws(() => parseSubmitInputRequest("value" in forwarded ? forwarded.value : undefined));
});

test("structured dispatch rejects malformed envelopes without executing getters", () => {
  let reads = 0;
  for (const value of [null, [], "serialized commands are not supported", new Date(),
    { action: "appendInput" }, { action: "unknown" }, { action: "getSession", value: null },
    { action: "getSession", extra: true }, { action: "getOperation", value: 1 },
    { get action() { reads++; return "getSession"; } },
    { action: "appendInput", get value() { reads++; return null; } },
  ]) assert.throws(() => parseSessionCommand(value));
  assert.equal(reads, 0);
  assert.deepEqual(parseSessionCommand({ action: "getMessages", value: {} }), { action: "getMessages", value: { after: 0, limit: 100 } });
});
