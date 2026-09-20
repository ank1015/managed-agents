import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { Logger, sampled } from "../src/index.ts";
import type { LogFields } from "../src/index.ts";

const sessionId = "ses_11111111-1111-4111-8111-111111111111";
const operationId = "replay-v1:12:" + "a".repeat(64);
test("projects only allowlisted bounded diagnostic fields, never payloads or Error objects", () => {
  const records: unknown[] = [];
  const logger = new Logger("test", {}, (level, record) => records.push({ level, ...record }));
  logger.error("callback_failed", { sessionId, operationId, stage: "completion", errorCode: "CALLBACK_UNAVAILABLE",
    gatewayJobId: "secret gateway token", durationMs: Infinity, retryable: true,
    message: "private prompt", error: new Error("Bearer secret"), stack: "secret stack",
    command: "private command", headers: { authorization: "secret" }, body: "private output",
  } as LogFields);
  assert.deepEqual(records, [{ level: "error", service: "test", event: "callback_failed",
    stage: "completion", errorCode: "CALLBACK_UNAVAILABLE", sessionId, operationId, retryable: true }]);
});
test("success sampling is stable across services; errors are never sampled", () => {
  const records: unknown[] = [], sink = (_level: unknown, record: unknown) => records.push(record);
  const a = new Logger("a", { LOG_SUCCESS_SAMPLE_RATE: "0" }, sink);
  a.success("completed", { sessionId }); a.error("failed", { sessionId }); a.warn("retry", { sessionId });
  assert.equal(records.length, 2);
  const b = new Logger("b", { LOG_SUCCESS_SAMPLE_RATE: "1" }, sink);
  b.success("completed", { sessionId }); assert.equal(records.length, 3);
  const c = new Logger("c", { LOG_SUCCESS_SAMPLE_RATE: "0", LOG_DEBUG: "true" }, sink);
  c.success("completed", { sessionId }); assert.equal(records.length, 4);
  const ids = Array.from({ length: 10_000 }, (_, i) => `ses_${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`);
  const picked = ids.filter(id => sampled(id, 0.01));
  assert(picked.length > 40 && picked.length < 170);
  for (const id of ids) assert.equal(sampled(id, 0.01), sampled(id, 0.01));
  for (const setting of ["garbage", "-1", "2", ""]) {
    const logs: unknown[] = [];
    const logger = new Logger("test", { LOG_SUCCESS_SAMPLE_RATE: setting }, (_level, record) => logs.push(record));
    for (const id of ids) logger.success("done", { sessionId: id });
    assert.equal(logs.length, picked.length);
  }
});
test("unauthenticated rejection sampling cannot be enabled by debug mode", t => {
  const records: unknown[] = [];
  const logger = new Logger("test", { LOG_DEBUG: "true" }, (_level, record) => records.push(record));
  t.mock.method(Math, "random", () => 0.5);
  logger.rejection("unauthorized"); assert.equal(records.length, 0);
  t.mock.method(Math, "random", () => 0);
  logger.rejection("unauthorized"); assert.equal(records.length, 1);
});
test("sink failure cannot fail application work", () => {
  const logger = new Logger("test", { LOG_DEBUG: "true" }, () => { throw new Error("sink unavailable"); });
  assert.doesNotThrow(() => logger.error("failed"));
  assert.doesNotThrow(() => logger.success("done", { sessionId }));
});
test("all deployed services and bootstrap disable invocation logs without dropping failure samples", async () => {
  for (const path of ["agent-api", "harness-minimal-bash", "llm-gateway-workers", "tool-pi-bash-workers", "execution-gateway-callback-workers"]) {
    const config = JSON.parse((await readFile(new URL(`../../../apps/${path}/wrangler.jsonc`, import.meta.url), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
    assert.equal(config.observability.enabled, true);
    assert.equal(config.observability.head_sampling_rate, 1);
    assert.equal(config.observability.logs.invocation_logs, false);
  }
  const bootstrap = JSON.parse((await readFile(new URL("../../../apps/harness-minimal-bash/wrangler.bootstrap.jsonc", import.meta.url), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(bootstrap.observability.logs.invocation_logs, false);
});
