import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { withDeadline, REQUEST_BUDGET_MS } from "../src/deadline.ts";
import { readLimited } from "../src/gateway.ts";

test("deadline aborts stalled HTTP body consumption rather than leaving background reads", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(withDeadline(signal => readLimited(body, 1024, signal), 20), /deadline/);
  await sleep(0);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.ok(REQUEST_BUDGET_MS < 10_000);
});

test("deadline observes late non-abortable RPC rejection, and completed work clears its timer", async () => {
  await assert.rejects(withDeadline(async () => { await sleep(50); throw new Error("late RPC failure"); }, 10), /deadline/);
  await sleep(60); // node:test fails on an unhandled rejection from the losing RPC.
  let signal: AbortSignal | undefined;
  assert.equal(await withDeadline(async value => { signal = value; return 42; }, 10), 42);
  await sleep(20);
  assert.equal(signal!.aborted, false);
});
