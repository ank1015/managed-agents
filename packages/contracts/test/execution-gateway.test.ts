import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExecutionGatewayContext, parseExecutionGatewayEvent, parseGatewayEventReceipt, parseBashInput } from "../src/index.ts";
const id = "00000000-0000-4000-8000-000000000001";
const clientContext = { receiver: "tool-pi-bash-v1", reference: "submission-1" };
const event = { schemaVersion: 2, eventId: id, jobId: id, machineId: id, type: "job.succeeded", completedAt: "2026-09-18T00:00:00Z", clientContext };
test("execution event and durable receipt preserve exact routing/correlation", () => {
  assert.deepEqual(parseExecutionGatewayContext(clientContext), clientContext);
  for (const type of ["job.succeeded", "job.failed", "job.unknown"]) assert.deepEqual(parseExecutionGatewayEvent({ ...event, type }), { ...event, type });
  const receipt = { status: "accepted", eventId: id, jobId: id, clientContext };
  assert.deepEqual(parseGatewayEventReceipt(receipt), receipt);
  for (const invalid of [{ ...receipt, status: "queued" }, { ...receipt, eventId: "bad" }, { ...receipt, clientContext: null }, { ...receipt, extra: true }]) assert.throws(() => parseGatewayEventReceipt(invalid));
});
test("router convention rejects missing/extra context, arbitrary URLs and invalid terminal events", () => {
  const { clientContext: _, ...withoutContext } = event;
  for (const invalid of [withoutContext, { ...event, schemaVersion: 1 }, { ...event, type: "job.pending" },
    { ...event, completedAt: "not a timestamp" }, { ...event, jobId: "bad" }, { ...event, response: {} },
    ...[null, {}, { ...clientContext, receiver: "https://example.com" }, { ...clientContext, reference: "" },
      { ...clientContext, reference: "x".repeat(2049) }, { ...clientContext, callbackUrl: "https://example.com" }].map(clientContext => ({ ...event, clientContext }))]) {
    assert.throws(() => parseExecutionGatewayEvent(invalid));
  }
  // Routing metadata is infrastructure-owned, not a model/harness tool argument.
  assert.throws(() => parseBashInput({ machineId: id, cwd: "/", command: "pwd", clientContext }));
});
