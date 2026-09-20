import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/webhook.ts", import.meta.url))], bundle: true,
  format: "esm", platform: "node", write: false });
const { webhook } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0]!.text).toString("base64")) as { webhook(request: Request, env: Record<string, unknown>): Promise<Response> };
const secret = "test-secret", sessionId = "ses_11111111-1111-4111-8111-111111111111";
function signed(value: Record<string, unknown>) {
  const body = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://test/webhook", { method: "POST", body, headers: {
    "Content-Type": "application/json", "X-LLM-Gateway-Timestamp": timestamp,
    "X-LLM-Gateway-Event-Id": String(value.eventId),
    "X-LLM-Gateway-Signature": "v1=" + createHmac("sha256", secret).update(timestamp + "." + value.eventId + "." + body).digest("hex"),
  } });
}
test("authenticated malformed callbacks and failed delivery log once without inline payloads", async t => {
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, "error", (value: Record<string, unknown>) => logs.push(value));
  const env = { GATEWAY_WEBHOOK_SECRET: secret, LOG_SUCCESS_SAMPLE_RATE: "0", GATEWAY_URL: "https://gateway.test", GATEWAY_API_KEY: "unused", SESSION_ROUTES: JSON.stringify({ "test-v1": "SESSIONS" }),
SESSIONS: { idFromName: () => ({}), get: () => ({ sessionRequest: async () => { throw new Error("private upstream response"); } }) }, };
  assert.equal((await webhook(signed({ eventId: randomUUID(), private: "private prompt" }), env)).status, 400);
  assert.equal(logs.length, 1); assert.equal(logs[0]?.event, "callback_invalid");
  logs.length = 0;
  const evt = { schemaVersion: 2, eventId: randomUUID(), jobId: randomUUID(), type: "job.failed", completedAt: new Date().toISOString(),
clientContext: { routeKey: "test-v1", sessionId, operationId: "replay-v1:1:" + "a".repeat(64), submissionId: "replay-v1:1:" + "a".repeat(64) },
response: null, error: { code: "model_error", message: "private model content", retryable: false } };
  assert.equal((await webhook(signed(evt), env)).status, 503);
  assert.equal(logs.length, 1); assert.equal(logs[0]?.event, "callback_failed");
  assert.equal(logs[0]?.sessionId, sessionId); assert.equal(logs[0]?.gatewayJobId, evt.jobId);
  assert.equal(logs[0]?.retryable, true);
  assert.doesNotMatch(JSON.stringify(logs), /private|test-secret|test-key/);
});
