import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExecutionGatewayContext, parseExecutionGatewayEvent, parseGatewayEventReceipt, parseGatewayEventReply, parseBashInput } from "../src/index.ts";
const id = "00000000-0000-4000-8000-000000000001";
const clientContext = { receiver: "tool-pi-bash-v1", sessionId: "session", timeoutSeconds: null };
const event = { schemaVersion: 3, eventId: id, jobId: id, machineId: id, idempotencyKey: "key", runtimeGenerationId: id,
  response: { protocol_version: 4 }, error: null, type: "job.succeeded", completedAt: "2026-09-18T00:00:00Z", clientContext };
test("v3 inline execution event and durable receipt preserve exact routing/correlation", () => {
  assert.deepEqual(parseExecutionGatewayContext(clientContext), clientContext);
  for (const type of ["job.succeeded", "job.failed", "job.unknown"]) assert.deepEqual(parseExecutionGatewayEvent({ ...event, type }), { ...event, type });
  const receipt = { status: "accepted", eventId: id, jobId: id, clientContext };
  assert.deepEqual(parseGatewayEventReceipt(receipt), receipt);
  let disposed = false;
  assert.deepEqual(parseGatewayEventReply({ receipt, [Symbol.dispose]() { disposed = true; } }), receipt);
  assert.equal(disposed, true);
  disposed = false;
  assert.throws(() => parseGatewayEventReply({ receipt: {}, [Symbol.dispose]() { disposed = true; } }));
  assert.equal(disposed, true);
  for (const invalid of [{ ...receipt, status: "queued" }, { ...receipt, eventId: "bad" }, { ...receipt, clientContext: null }, { ...receipt, extra: true }]) assert.throws(() => parseGatewayEventReceipt(invalid));
});
test("router validates v3 envelope and receiver; tool-specific context remains opaque", () => {
  const { clientContext: _, ...withoutContext } = event;
  for (const invalid of [withoutContext, { ...event, schemaVersion: 2 }, { ...event, type: "job.pending" },
    { ...event, completedAt: "not a timestamp" }, { ...event, jobId: "bad" }, { ...event, response: undefined },
    { ...event, error: undefined }, { ...event, runtimeGenerationId: undefined }, { ...event, idempotencyKey: "" },
    { ...event, idempotencyKey: "x".repeat(201) }, { ...event, idempotencyKey: "has space" },
    ...[null, {}, { receiver: "https://example.com" }].map(clientContext => ({ ...event, clientContext }))]) {
    assert.throws(() => parseExecutionGatewayEvent(invalid));
  }
  assert.deepEqual(parseExecutionGatewayEvent({ ...event, runtimeGenerationId: null }).runtimeGenerationId, null);
  const opaque = { receiver: "another-tool", payload: { key: [1, false, null] } };
  assert.deepEqual(parseExecutionGatewayContext(opaque), opaque);
  assert.throws(() => parseBashInput({ machineId: id, cwd: "/", command: "pwd", clientContext }));
});
