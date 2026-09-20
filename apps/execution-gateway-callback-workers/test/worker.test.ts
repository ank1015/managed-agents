import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startStack, event, signed, url } from "./stack.ts";

test("stateless router forwards signed inline results to allowlisted tools and acknowledges after receipt", async () => {
  const stack = await startStack();
  try {
    for (const receiver of ["tool-pi-bash-v1", "tool-patch-v1"]) {
      const n = event(receiver);
      assert.equal((await stack.callback.fetch(url, signed(n))).status, 204);
      assert.deepEqual((await stack.call("/events", { receiver })).events, [n]);
      assert.equal((await stack.callback.fetch(url, signed(n))).status, 204);
      assert.equal((await stack.call("/events", { receiver })).events!.length, 1);
    }
    assert.equal((await stack.callback.fetch("https://callbacks.test/health")).status, 200);
    assert.equal((await stack.callback.fetch(url, { method: "GET" })).status, 405);
    assert.equal((await stack.callback.fetch(url + "?extra=1", signed(event()))).status, 404);
  } finally { await stack.app.dispose(); }
});

test("receiver outage, lost receipt and invalid receipt stay retryable, with no early acknowledgement", async () => {
  const stack = await startStack(), n = event(), receiver = n.clientContext.receiver;
  try {
    await stack.call("/faults", { receiver, fail: 1, lose: 1 });
    assert.equal((await stack.callback.fetch(url, signed(n))).status, 503);
    assert.equal((await stack.call("/events", { receiver })).events!.length, 0);
    assert.equal((await stack.callback.fetch(url, signed(n))).status, 503);
    assert.equal((await stack.call("/events", { receiver })).events!.length, 1);
    await stack.call("/faults", { receiver, bad: 1 });
    assert.equal((await stack.callback.fetch(url, signed(n))).status, 503);
    await stack.call("/faults", { receiver });
    assert.equal((await stack.callback.fetch(url, signed(n))).status, 204);
  } finally { await stack.app.dispose(); }
});

test("fresh signatures cover result/context; old schemas, missing result fields and unknown routes reject", async () => {
  const stack = await startStack(), n = event();
  try {
    assert.equal((await stack.callback.fetch(url, signed(n, "wrong"))).status, 401);
    assert.equal((await stack.callback.fetch(url, signed(n, undefined, "1"))).status, 401);
    const tampered = signed(n); tampered.body = tampered.body.replace("inline", "forged");
    assert.equal((await stack.callback.fetch(url, tampered)).status, 401);
    const mismatch = signed(n); mismatch.headers["X-Execution-Gateway-Event-Id"] = randomUUID();
    assert.equal((await stack.callback.fetch(url, mismatch)).status, 401);
    for (const patch of [{ schemaVersion: 2 }, { response: undefined }, { error: undefined },
      { runtimeGenerationId: undefined }, { clientContext: null }, { type: "job.running" }]) {
      assert.equal((await stack.callback.fetch(url, signed({ ...n, ...patch }))).status, 400);
    }
    assert.equal((await stack.callback.fetch(url, signed(event("unconfigured-tool")))).status, 503);
    assert.equal((await stack.callback.fetch(url, signed(n, "previous-secret"))).status, 204);
  } finally { await stack.app.dispose(); }
});

test("inline result may exceed old 16 KiB cap; body above 18 MiB transport bound is not forwarded", async () => {
  const stack = await startStack(), n = event();
  try {
    n.response.result = "x".repeat(100_000);
    assert.equal((await stack.callback.fetch(url, signed(n))).status, 204);
    const huge = signed(event()); huge.body = "x".repeat(18 * 1024 * 1024 + 1);
    assert.equal((await stack.callback.fetch(url, huge)).status, 413);
    assert.equal((await stack.call("/events", { receiver: n.clientContext.receiver })).events!.length, 1);
  } finally { await stack.app.dispose(); }
});

test("gateway redelivery survives router/receiver restart after acknowledgement loss", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "execution-router-stateless-")), n = event(), receiver = n.clientContext.receiver;
  let stack = await startStack({ persistPath });
  try {
    await stack.call("/faults", { receiver, lose: 1 });
    assert.equal((await stack.callback.fetch(url, signed(n))).status, 503);
    await stack.app.dispose(); stack = await startStack({ persistPath });
    assert.equal((await stack.callback.fetch(url, signed(n))).status, 204);
    assert.equal((await stack.call("/events", { receiver })).events!.length, 1);
  } finally { await stack.app.dispose(); }
});

test("router config has no database, Queue, cron or gateway credentials", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(config, /d1_databases|queues|CALLBACK_DB|DELIVERIES|API_KEY/);
  assert.match(config, /"crons":\s*\[\]/);
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /async (queue|scheduled)\(/);
});
