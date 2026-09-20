import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const output = await build({ entryPoints: [fileURLToPath(new URL("../src/service.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", write: false });
const { LlmService } = await import("data:text/javascript;base64," + Buffer.from(output.outputFiles[0]!.text).toString("base64")) as {
  LlmService: new (env: Record<string, unknown>) => { submit(value: unknown): Promise<{ status: string }> }
};
test("submission rejection and uncertain acceptance have safe diagnostics, not request payloads", async t => {
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, "error", (record: Record<string, unknown>) => records.push(record));
  t.mock.method(console, "info", (record: Record<string, unknown>) => records.push(record));
  const service = new LlmService({ GATEWAY_URL: "https://gateway.test", GATEWAY_API_KEY: "private-api-key",
    LOG_SUCCESS_SAMPLE_RATE: "0", SESSION_ROUTES: JSON.stringify({ "test-v1": "SESSIONS" }),
    SESSIONS: { idFromName: () => ({}), get: () => ({}) },
  });
  assert.equal((await service.submit({ private: "private request" })).status, "rejected");
  assert.equal(records.length, 1); assert.equal(records[0]?.event, "submission_rejected");
  records.length = 0;
  t.mock.method(globalThis, "fetch", async () => new Response("private invalid upstream body", { status: 502 }));
  const sessionId = "ses_11111111-1111-4111-8111-111111111111";
  await assert.rejects(service.submit({ destination: { routeKey: "test-v1", sessionId },
    submission: { operationId: "replay-v1:1:" + "a".repeat(64), submissionId: "replay-v1:1:" + "a".repeat(64),
      request: { provider: "llm", type: "generate", version: "v1", input: {"accountId":"00000000-0000-4000-8000-000000000001","modelId":"test-model","messages":[{"role":"user","content":[{"type":"text","text":"private prompt"}]}]} } } }));
  assert.equal(records.length, 1); assert.equal(records[0]?.event, "submission_failed");
  assert.equal(records[0]?.sessionId, sessionId); assert.equal(records[0]?.retryable, true);
  assert.doesNotMatch(JSON.stringify(records), /private/);
});
