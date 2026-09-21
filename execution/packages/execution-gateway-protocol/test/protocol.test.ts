import test from "node:test";
import assert from "node:assert/strict";
import { canonical, jsonValue, signRoutingEnvelope, verifyRoutingEnvelope, issueMachineSecret, machineSecret, submission, hashJson, readJson, GatewayError } from "../src/index.ts";
const secret = "test-secret-with-at-least-thirty-two-bytes";
test("routing envelopes verify signatures, purpose and previous keys without expiring", async () => {
  const token = await signRoutingEnvelope(secret, { machineId: "machine" });
  assert.equal((await verifyRoutingEnvelope(secret, undefined, token)).machineId, "machine");
  await assert.rejects(verifyRoutingEnvelope(secret + "wrong", undefined, token));
  assert.equal((await verifyRoutingEnvelope(secret + "new", secret, token)).machineId, "machine");
  assert.throws(() => machineSecret(token, "execution"));
});
test("machine credentials are role-separated and issuance is retry-safe", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const token = await issueMachineSecret(secret, id, "execution", 1);
  assert.equal(token, await issueMachineSecret(secret, id, "execution", 1));
  assert.deepEqual(machineSecret(token, "execution"), { machineId: id, version: 1 });
  assert.throws(() => machineSecret(token, "daemon"));
  assert.notEqual(token, await issueMachineSecret(secret, id, "execution", 2));
  assert.notEqual(token, await issueMachineSecret(secret, id, "daemon", 1));
});
test("canonical fingerprints ignore object field order but preserve array order", async () => {
  assert.equal(await hashJson({ b: 2, a: { d: 4, c: 3 } }), await hashJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(await hashJson([1,2]), await hashJson([2,1]));
  assert.throws(() => jsonValue(JSON.parse('['.repeat(66) + '0' + ']'.repeat(66))));
});
test("submission preserves explicit launch context and rejects unsupported operations and callback URLs", () => {
  const operation = { operation: "execution.exec", params: { cwd: "/work", env: { MODE: "test" }, command: { type: "shell", script: "pwd" } } };
  const value = { requestId: "request", runtimeGeneration: "10000000-0000-4000-8000-000000000001", operation, callback: { receiver: "test", context: null } };
  assert.deepEqual(submission(value), value);
  assert.throws(() => submission({ ...value, callbackUrl: "https://attacker" }));
  assert.throws(() => submission({ ...value, operation: { operation: "unknown", params: {} } }));
});


test("JSON bodies enforce streaming size and read deadlines", async () => {
  const request = new Request("https://example.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ large: "x".repeat(100) }) });
  await assert.rejects(readJson(request, 20), (error: unknown) => error instanceof GatewayError && error.code === "BODY_TOO_LARGE");
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const slow = new Request("https://example.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readJson(slow, 20, 10), (error: unknown) => error instanceof GatewayError && error.code === "BODY_TIMEOUT");
  assert.equal(cancelled, true);
});
