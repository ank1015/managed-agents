import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startStack, event, signed, url, routes, until, row, process } from "./stack.ts";

test("signed callbacks route inline after durable admission, without Queue delivery or shared tool database access", async () => {
  const stack = await startStack({ autoQueue: false });
  try {
    for (const receiver of Object.keys(routes)) {
      const e = event(receiver);
      assert.equal((await stack.callback.fetch(url, signed(e))).status, 204);
      await until(async () => (await row(stack, e.eventId))?.delivered_at);
      assert.equal((await stack.callback.fetch(url, signed(e))).status, 204);
      assert.deepEqual((await stack.call("/events", { receiver })).events, [e]);
    }
    assert.equal((await stack.db.prepare("SELECT COUNT(*) AS n FROM gateway_callback_events").first())!.n, 2);
    assert.equal((await stack.callback.fetch("https://callbacks.test/v1/jobs", { method: "POST" })).status, 404);
  } finally { await stack.app.dispose(); }
});
test("bad signatures, stale timestamps, tampered bodies and malformed contexts cannot be admitted", async () => {
  const stack = await startStack({ autoQueue: false });
  try {
    const e = event();
    assert.equal((await stack.callback.fetch(url, signed(e, "wrong"))).status, 401);
    assert.equal((await stack.callback.fetch(url, signed(e, undefined, "1"))).status, 401);
    const tampered = signed(e); tampered.body += " ";
    assert.equal((await stack.callback.fetch(url, tampered)).status, 401);
    const mismatch = signed(e); mismatch.headers["X-Execution-Gateway-Event-Id"] = randomUUID();
    assert.equal((await stack.callback.fetch(url, mismatch)).status, 401);
    for (const invalid of [{ ...e, schemaVersion: 1 }, { ...e, clientContext: null },
      { ...e, clientContext: { receiver: "https://untrusted.test", reference: "x" } },
      { ...e, clientContext: { receiver: "tool-pi-bash-v1", reference: "" } },
      { ...e, clientContext: { ...e.clientContext, callbackUrl: "https://untrusted.test" } }]) {
      assert.equal((await stack.callback.fetch(url, signed(invalid))).status, 400);
    }
    assert.equal((await stack.callback.fetch(url, signed({ ...e, clientContext: { ...e.clientContext, reference: "x".repeat(20_000) } }))).status, 413);
    assert.equal((await stack.callback.fetch(url, { method: "POST", body: "{}" })).status, 415);
    assert.equal((await stack.callback.fetch(url, { method: "GET" })).status, 405);
    assert.equal((await stack.callback.fetch(url, signed(e, "previous-secret"))).status, 204);
    assert.equal((await stack.callback.fetch(url, signed(e))).status, 204);
    assert.equal((await stack.db.prepare("SELECT COUNT(*) AS n FROM gateway_callback_events").first())!.n, 1);
  } finally { await stack.app.dispose(); }
});
test("D1 failure is not acknowledged; conflicting event content cannot replace a retained route", async () => {
  const stack = await startStack({ autoQueue: false });
  try {
    const e = event();
    await stack.db.prepare("CREATE TRIGGER fail_admit BEFORE INSERT ON gateway_callback_events BEGIN SELECT RAISE(ABORT, 'Injected failure'); END").run();
    assert.equal((await stack.callback.fetch(url, signed(e))).status, 503);
    assert.equal(await row(stack, e.eventId), null);
    await stack.db.prepare("DROP TRIGGER fail_admit").run();
    assert.equal((await stack.callback.fetch(url, signed(e))).status, 204);
    for (const changed of [{ ...e, jobId: randomUUID() }, { ...e, machineId: randomUUID() },
      { ...e, clientContext: { ...e.clientContext, receiver: "tool-patch-v1" } },
      { ...e, clientContext: { ...e.clientContext, reference: "other" } }, { ...e, type: "job.failed" }]) {
      assert.equal((await stack.callback.fetch(url, signed(changed))).status, 503);
    }
    assert.equal((await row(stack, e.eventId))!.receiver, "tool-pi-bash-v1");
  } finally { await stack.app.dispose(); }
});
test("receiver outage and a lost durable receipt retry idempotently", async () => {
  const stack = await startStack({ autoQueue: false });
  try {
    const e = event();
    await stack.call("/faults", { receiver: e.clientContext.receiver, fail: 1, lose: 1 });
    assert.equal((await stack.callback.fetch(url, signed(e))).status, 204);
    await until(async () => (await row(stack, e.eventId))!.attempts === 1);
    assert.match(String((await row(stack, e.eventId))!.last_error), /injected receiver outage/i);
    assert.equal((await row(stack, e.eventId))!.delivered_at, null);
    assert.ok((await process(stack, e.eventId))! > 0);
    assert.equal((await row(stack, e.eventId))!.delivered_at, null);
    assert.equal(await process(stack, e.eventId), null);
    assert.deepEqual((await stack.call("/events", { receiver: e.clientContext.receiver })).events, [e]);
    assert.ok((await row(stack, e.eventId))!.delivered_at);
  } finally { await stack.app.dispose(); }
});
test("incorrect receipts and unavailable receiver routes remain durably pending", async () => {
  const stack = await startStack({ autoQueue: false });
  try {
    const e = event();
    await stack.call("/faults", { receiver: e.clientContext.receiver, bad: 1 });
    assert.equal((await stack.callback.fetch(url, signed(e))).status, 204);
    await until(async () => (await row(stack, e.eventId))!.attempts === 1);
    assert.match(String((await row(stack, e.eventId))!.last_error), /mismatched receipt/);
    assert.equal((await row(stack, e.eventId))!.delivered_at, null);
    const unknown = event("unconfigured-tool");
    assert.equal((await stack.callback.fetch(url, signed(unknown))).status, 204);
    await until(async () => (await row(stack, unknown.eventId))!.attempts === 1);
    assert.match(String((await row(stack, unknown.eventId))!.last_error), /not configured/);
  } finally { await stack.app.dispose(); }
});
test("concurrent queue work is fenced and duplicate notifications do not redeliver completed events", async () => {
  const stack = await startStack({ autoQueue: false });
  try {
    const e = event();
    await Promise.all(Array.from({ length: 5 }, () => stack.callback.fetch(url, signed(e))));
    await Promise.all(Array.from({ length: 5 }, () => stack.call("/process", { eventId: e.eventId })));
    const completed = (await row(stack, e.eventId))!;
    assert.ok(completed.delivered_at); assert.equal(completed.attempts, 1);
    assert.equal(await process(stack, e.eventId), null);
    assert.equal((await row(stack, e.eventId))!.attempts, 1);
  } finally { await stack.app.dispose(); }
});
test("restart and cron recover a failed enqueue and an expired delivery lease", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "execution-callback-test-"));
  let stack = await startStack({ autoQueue: false, queueFails: true, persistPath });
  try {
    const e = event();
    assert.equal((await stack.callback.fetch(url, signed(e))).status, 204);
    await stack.db.prepare("UPDATE gateway_callback_events SET lease_token = 'crashed', lease_until = 1, next_attempt_at = 0").run();
    await stack.app.dispose();
    stack = await startStack({ persistPath });
    await stack.call("/recover");
    await until(async () => (await row(stack, e.eventId))?.delivered_at);
    assert.deepEqual((await stack.call("/events", { receiver: e.clientContext.receiver })).events, [e]);
  } finally { await stack.app.dispose(); }
});
