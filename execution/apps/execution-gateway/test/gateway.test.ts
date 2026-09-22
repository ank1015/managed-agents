import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { hashJson, jsonValue, verifyRoutingEnvelope, routingFields } from "@managed-agents/execution-gateway-protocol";
import { backend, generation, input, machineId, stack, routingSecret, until } from "./stack.ts";

test("registration recovers lost secrets, isolates machines, and exposes no user/grant API", async t => {
  const s = await stack(); t.after(() => s.app.dispose());
  assert.equal((await s.request("/health", "GET", undefined, "bad")).status, 200);
  const body = { machineId, name: "Test machine" };
  assert.equal((await s.request("/v1/machines", "POST", body, "bad")).status, 401);
  const first = await s.request("/v1/machines", "POST", body); assert.equal(first.status, 201);
  const issued = await first.json() as any;
  const replay = await s.request("/v1/machines", "POST", body); assert.equal(replay.status, 200);
  const saved = await replay.json() as any;
  assert.equal(saved.daemonSecret, issued.daemonSecret); assert.equal(saved.executionSecret, issued.executionSecret);
  assert.equal((await s.request("/v1/machines", "POST", { ...body, name: "changed" })).status, 409);
  assert.equal((await s.request(`/v1/machines/${machineId}`, "GET", undefined, issued.daemonSecret)).status, 401);
  const other = crypto.randomUUID(); await s.register(other);
  assert.equal((await s.request(`/v1/machines/${other}`, "GET", undefined, issued.executionSecret)).status, 401);
  const view = await s.request(`/v1/machines/${machineId}`, "GET", undefined, issued.executionSecret);
  const text = await view.text(); assert.ok(!text.includes("hash")); assert.ok(!text.includes(issued.executionSecret));
  for (const route of ["/v1/users/alice/machines", "/v1/requests", "/v1/connect", "/v1/machine-token/refresh"]) assert.equal((await s.request(route)).status, 404);
  assert.equal((await s.request(`/v1/machines/${machineId}/secrets/rotate`, "POST", { kind: "daemon", expectedVersion: 1 }, issued.executionSecret)).status, 401);
  const connect = (token: string) => s.api.fetch(`https://gateway/v1/machines/${machineId}/connect`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
  assert.equal((await connect(issued.executionSecret)).status, 401);
  assert.equal((await s.request(`/v1/machines/${machineId}/requests`, "POST", input(), issued.daemonSecret)).status, 401);
});
test("independent secret rotation is retry-safe; accepted callbacks survive execution-secret revocation", async t => {
  const s = await stack(); t.after(() => s.app.dispose());
  const token = await s.register(), peer = await s.connect(token), secret = await s.executionSecret();
  const requestPath = `/v1/machines/${machineId}/requests`, rotatePath = `/v1/machines/${machineId}/secrets/rotate`;
  const pending = s.request(requestPath, "POST", input(), secret), frame = await peer.next("request"); peer.accept(frame); assert.equal((await pending).status, 202);
  const rotate = { kind: "execution", expectedVersion: 1 };
  const rotated = await (await s.request(rotatePath, "POST", rotate)).json() as any;
  assert.equal(rotated.version, 2); assert.equal(peer.closed, false);
  assert.deepEqual(await (await s.request(rotatePath, "POST", rotate)).json(), rotated);
  assert.equal((await s.request(requestPath, "POST", input(), secret)).status, 401);
  const replay = s.request(requestPath, "POST", input(), rotated.secret), again = await peer.next("request");
  assert.equal(again.requestHash, frame.requestHash); peer.accept(again); assert.equal((await replay).status, 202);
  await peer.result(frame); await peer.next("result_ack");
  const daemon = await (await s.request(rotatePath, "POST", { kind: "daemon", expectedVersion: 1 })).json() as any;
  await until(() => peer.closed); const newer = await s.connect(daemon.secret);
  await s.request(rotatePath, "POST", { kind: "daemon", expectedVersion: 1 }); assert.equal(newer.closed, false);
  assert.equal((await s.request(rotatePath, "POST", { kind: "execution", expectedVersion: 9 })).status, 409);
  assert.equal((await s.request("/v1/machines", "POST", { machineId, name: "Test machine" })).status, 409);
  await assert.rejects(s.connect(token));
});
test("deletion disconnects and permanently fences an identity, including outstanding delivery", async t => {
  const s = await stack(); t.after(() => s.app.dispose());
  const daemon = await s.register(), peer = await s.connect(daemon), secret = await s.executionSecret();
  const path = `/v1/machines/${machineId}`;
  assert.equal((await s.request(path, "DELETE", undefined, secret)).status, 401);
  assert.equal((await s.request(path, "DELETE")).status, 200); await until(() => peer.closed);
  assert.equal((await s.request(path, "DELETE")).status, 200);
  assert.equal((await s.request(path, "GET", undefined, secret)).status, 410);
  assert.equal((await s.request(path + "/requests", "POST", input(), secret)).status, 410);
  assert.equal((await s.request("/v1/machines", "POST", { machineId, name: "Test machine" })).status, 410);
  await assert.rejects(s.connect(daemon));
});
test("each machine has its own admission budget and connection epoch", async t => {
  const s = await stack({ vars: { MAX_PENDING_SUBMISSIONS: "1" } }); t.after(() => s.app.dispose());
  const daemon = await s.register(), old = await s.connect(daemon), peer = await s.connect(daemon);
  await until(() => old.closed);
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), await s.executionSecret());
  const first = await peer.next("request");
  const otherId = crypto.randomUUID(), other = await s.connect(await s.register(otherId));
  const independent = s.request(`/v1/machines/${otherId}/requests`, "POST", input(), await s.executionSecret(otherId));
  const second = await other.next("request"); other.accept(second); peer.accept(first);
  assert.equal((await independent).status, 202); assert.equal((await pending).status, 202);
});
test("submission waits for matching daemon acceptance and generation and capabilities fence execution", async t => {
  const s = await stack(); t.after(() => s.app.dispose()); const peer = await s.connect(await s.register());
  const secret = await s.executionSecret();
  assert.equal((await s.request(`/v1/machines/${machineId}/requests`, "POST", input("bad", { runtimeGeneration: crypto.randomUUID() }), secret)).status, 409);
  let settled = false; const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret).then(r => { settled = true; return r; });
  const request = await peer.next("request"); await setTimeout(20); assert.equal(settled, false);
  assert.deepEqual(request.operation, input().operation);
  assert.equal(request.requestHash, await hashJson(jsonValue({ machineId, runtimeGeneration: generation,
    requestId: input().requestId, operation: input().operation, callback: input().callback })));
  const envelope = routingFields(await verifyRoutingEnvelope(routingSecret, undefined, request.routingEnvelope));
  assert.deepEqual(envelope, { machineId, runtimeGeneration: generation, requestId: input().requestId,
    requestHash: request.requestHash, callback: input().callback });
  peer.accept(request); const response = await pending; assert.equal(response.status, 202);
  assert.equal((await response.json() as any).requestHash, request.requestHash);
  const fresh = await s.connect(await s.register(), { runtimeGeneration: crypto.randomUUID() });
  assert.equal((await s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret)).status, 409);
  assert.equal(fresh.messages.some(m => m.type === "request"), false);
});

test("acceptance loss is uncertain and same-identity retries preserve the envelope fingerprint", async t => {
  const s = await stack(); t.after(() => s.app.dispose()); const peer = await s.connect(await s.register()), secret = await s.executionSecret();
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret); const first = await peer.next("request");
  const failed = await pending; assert.equal(failed.status, 504); assert.equal((await failed.json() as any).error.uncertain, true);
  const retry = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret), next = await peer.next("request");
  assert.equal(first.requestHash, next.requestHash); assert.notEqual(first.dispatchId, next.dispatchId);
  peer.accept(first); peer.accept(next); assert.equal((await retry).status, 202);
});

test("result acknowledgements require matching durable admission; failed and lost callbacks redeliver", async t => {
  const s = await stack(); t.after(() => s.app.dispose()); const peer = await s.connect(await s.register()), secret = await s.executionSecret();
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret), request = await peer.next("request"); peer.accept(request); await pending;
  await s.faults({ fail: 1 }); const frame = await peer.result(request);
  assert.equal((await peer.next("result_nack")).error.retryable, true); assert.equal((await s.events()).length, 0);
  await s.faults({ lose: 1 }); peer.send(frame); await peer.next("result_nack"); assert.equal((await s.events()).length, 1);
  await s.faults({ bad: 1 }); peer.send(frame); assert.equal((await peer.next("result_nack")).error.code, "INVALID_CALLBACK_RECEIPT");
  peer.send(frame); const ack = await peer.next("result_ack"); assert.equal(ack.deliveryId, frame.deliveryId); assert.equal((await s.events()).length, 1);
  peer.send(frame); await peer.next("result_ack"); assert.equal((await s.events()).length, 1);
  assert.deepEqual((await s.events())[0], { protocolVersion: 1, machineId, runtimeGeneration: generation,
    requestId: request.requestId, requestHash: request.requestHash, callback: input().callback,
    deliveryId: frame.deliveryId, resultHash: ack.resultHash, outcome: frame.outcome });
});

test("completion may arrive before acceptance and survives reconnection with a saved routing envelope", async t => {
  const s = await stack(); t.after(() => s.app.dispose()); const token = await s.register(), peer = await s.connect(token), secret = await s.executionSecret();
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret), request = await peer.next("request");
  const frame = await peer.result(request); await peer.next("result_ack"); peer.accept(request); assert.equal((await pending).status, 202);
  const next = await s.connect(token, { runtimeGeneration: crypto.randomUUID() }); next.send(frame); await next.next("result_ack");
  assert.equal((await s.events()).length, 1);
});

test("routing envelopes cannot be tampered with or used by another machine", async t => {
  const s = await stack(); t.after(() => s.app.dispose()); const peer = await s.connect(await s.register()), secret = await s.executionSecret();
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret), request = await peer.next("request"); peer.accept(request); await pending;
  const frame = await peer.result(request); await peer.next("result_ack");
  const bad = frame.routingEnvelope.split("."); bad[1] = Buffer.from(JSON.stringify({ sub: "bob" })).toString("base64url"); peer.send({ ...frame, routingEnvelope: bad.join(".") });
  assert.equal((await peer.next("result_nack")).error.code, "INVALID_ENVELOPE");
  const other = await s.connect(await s.register(crypto.randomUUID())); other.send(frame);
  assert.equal((await other.next("result_nack")).error.code, "RESULT_FORBIDDEN"); assert.equal((await s.events()).length, 1);
});

test("offline, capacity and malformed acceptance produce explicit errors without accepting work", async t => {
  const s = await stack({ vars: { MAX_PENDING_SUBMISSIONS: "1" } }); t.after(() => s.app.dispose());
  const token = await s.register();
  const peer = await s.connect(token), secret = await s.executionSecret();
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret), request = await peer.next("request");
  assert.equal((await s.request(`/v1/machines/${machineId}/requests`, "POST", input("second"), secret)).status, 429);
  peer.send({ type: "accepted", dispatchId: request.dispatchId, requestId: "wrong", requestHash: request.requestHash, runtimeGeneration: generation });
  assert.equal((await pending).status, 503); await until(() => peer.closed);
  assert.equal((await s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret)).status, 503);
});

test("registry survives process restart while sockets correctly become offline", async () => {
  const path = await mkdtemp(join(tmpdir(), "machine-gateway-test-"));
  let s = await stack({ persist: path });
  try {
    const token = await s.register(); await s.connect(token); await s.app.dispose();
    s = await stack({ persist: path });
    const row = (await (await s.request(`/v1/machines/${machineId}`, "GET", undefined, await s.executionSecret())).json() as any).machine;
    assert.equal(row.name, "Test machine"); assert.equal(row.connectionStatus, "offline"); assert.equal(row.runtimeGeneration, null);
    await s.connect(token); const next = (await (await s.request(`/v1/machines/${machineId}`, "GET", undefined, await s.executionSecret())).json() as any).machine; assert.equal(next.connectionEpoch, 2);
  } finally { await s.app.dispose(); await rm(path, { recursive: true, force: true }); }
});

test("hibernation preserves sockets, attachments and stateless completion delivery", async t => {
  const s = await stack(); t.after(() => s.app.dispose());
  const peer = await s.connect(await s.register()), secret = await s.executionSecret();
  await s.app.unsafeEvictDurableObject("gateway", "Machine", { name: machineId, webSockets: "hibernate" });
  const row = (await (await s.request(`/v1/machines/${machineId}`, "GET", undefined, await s.executionSecret())).json() as any).machine;
  assert.equal(row.connectionStatus, "ready"); assert.equal(row.runtimeGeneration, generation); assert.equal(peer.closed, false);
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret), request = await peer.next("request");
  peer.accept(request); assert.equal((await pending).status, 202);
  await s.app.unsafeEvictDurableObject("gateway", "Machine", { name: machineId, webSockets: "hibernate" });
  await peer.result(request); await peer.next("result_ack"); assert.equal((await s.events()).length, 1);
});

test("late callback admission can be retried; conflicting results are permanently rejected", async t => {
  const s = await stack({ vars: { CALLBACK_TIMEOUT_MS: "50" } }); t.after(() => s.app.dispose());
  const peer = await s.connect(await s.register()), secret = await s.executionSecret();
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret), request = await peer.next("request"); peer.accept(request); await pending;
  await s.faults({ delay: 150 }); const frame = await peer.result(request);
  assert.equal((await peer.next("result_nack")).error.code, "CALLBACK_TIMEOUT");
  await until(async () => (await s.events()).length === 1);
  await s.faults({ delay: 0 }); peer.send(frame); await peer.next("result_ack");
  await peer.result(request, { status: "error", error: { code: "OTHER_RESULT", message: "different\nresult", uncertain: false } });
  const rejected = await peer.next("result_nack"); assert.equal(rejected.error.code, "COMPLETION_CONFLICT"); assert.equal(rejected.error.retryable, false);
  assert.equal((await s.events()).length, 1);
});

test("multi-megabyte image-sized results survive WebSocket and private RPC delivery intact", async t => {
  const s = await stack({ vars: { CALLBACK_TIMEOUT_MS: "10000" } }); t.after(() => s.app.dispose());
  const peer = await s.connect(await s.register()), secret = await s.executionSecret();
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(), secret), request = await peer.next("request"); peer.accept(request); await pending;
  const payload = "a".repeat(7 * 1024 * 1024);
  await peer.result(request, { status: "ok", result: { data_base64: payload } });
  await peer.next("result_ack", 15000);
  assert.equal((await s.events())[0].outcome.result.data_base64, payload);
});


test("concurrent large submission bodies share a bounded budget that is released after acceptance", async t => {
  const s = await stack({ vars: { MAX_BUFFERED_BYTES: "8519680", ACCEPT_TIMEOUT_MS: "3000" } }); t.after(() => s.app.dispose());
  const peer = await s.connect(await s.register()), secret = await s.executionSecret();
  const body = input("large", { operation: { operation: "filesystem.write", params: { cwd: "/tmp", path: "x", content: { type: "text", data: "x".repeat(5 * 1024 * 1024) } } } });
  const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", body, secret), first = await peer.next("request");
  const rejected = await s.request(`/v1/machines/${machineId}/requests`, "POST", { ...body, requestId: "second" }, secret);
  assert.equal(rejected.status, 429); assert.equal((await rejected.json() as any).error.code, "BUFFER_CAPACITY");
  peer.accept(first); assert.equal((await pending).status, 202);
  const next = s.request(`/v1/machines/${machineId}/requests`, "POST", { ...body, requestId: "second" }, secret);
  peer.accept(await peer.next("request")); assert.equal((await next).status, 202);
});


test("peer close completes the WebSocket handshake and makes the machine offline", async t => {
  const s = await stack(); t.after(() => s.app.dispose());
  const peer = await s.connect(await s.register()); peer.ws.close(1000, "Shutdown");
  await until(() => peer.closed);
  const row = (await (await s.request(`/v1/machines/${machineId}`, "GET", undefined, await s.executionSecret())).json() as any).machine;
  assert.equal(row.connectionStatus, "offline"); assert.ok(row.lastDisconnectedAt);
});

test("sixteen concurrent result callbacks are allowed and excess deliveries remain retryable", async t => {
  for (const configuredLimit of [undefined, "16", "2"]) {
    await t.test(configuredLimit === undefined ? "default sixteen" : `configured ${configuredLimit}`, async t => {
      const limit = Number(configuredLimit ?? 16);
      const s = await stack({ vars: { ACCEPT_TIMEOUT_MS: "3000", CALLBACK_TIMEOUT_MS: "30000",
        ...(configuredLimit === undefined ? {} : { MAX_CONCURRENT_DELIVERIES: configuredLimit }) } });
      t.after(() => s.app.dispose());
      const peer = await s.connect(await s.register()), secret = await s.executionSecret();
      await s.faults({ hold: 1 });
      const frames = [];
      for (let i = 0; i <= limit; i++) {
        const pending = s.request(`/v1/machines/${machineId}/requests`, "POST", input(`burst-${i}`), secret);
        const frame = await peer.next("request"); peer.accept(frame);
        assert.equal((await pending).status, 202); frames.push(frame);
      }
      for (const frame of frames.slice(0, limit)) await peer.result(frame);
      await until(async () => (await (await s.receipts.fetch("https://receiver/snapshot")).json() as { held: number }).held === limit);
      assert.equal(peer.messages.some(m => m.type === "result_nack"), false);
      const excess = await peer.result(frames[limit]);
      const busy = await peer.next("result_nack");
      assert.equal(busy.deliveryId, excess.deliveryId);
      assert.deepEqual(busy.error, { code: "DELIVERY_CAPACITY", retryable: true });

      // The delivery budget is per machine, not shared across the gateway.
      const otherId = crypto.randomUUID(), other = await s.connect(await s.register(otherId));
      const independent = s.request(`/v1/machines/${otherId}/requests`, "POST", input("other", {
        callback: { receiver: "test-v1", context: { sessionId: "other-session" } },
      }), await s.executionSecret(otherId));
      const otherFrame = await other.next("request"); other.accept(otherFrame);
      assert.equal((await independent).status, 202);
      await other.result(otherFrame); await other.next("result_ack");

      await s.faults({ hold: 0 });
      for (let i = 0; i < limit; i++) await peer.next("result_ack");
      assert.equal((await s.events()).length, limit);
      peer.send(excess);
      assert.equal((await peer.next("result_ack")).deliveryId, excess.deliveryId);
      assert.equal((await s.events()).length, limit + 1);
    });
  }
});
