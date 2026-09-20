import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))], bundle: true,
  format: "esm", platform: "node", write: false });
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0]!.text).toString("base64")) as { default: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> } };

test("API 503 emits one safe diagnostic, while health and normal 4xx stay quiet", async t => {
  const logs: unknown[] = [];
  t.mock.method(console, "error", (value: unknown) => logs.push(value));
  t.mock.method(console, "warn", (value: unknown) => logs.push(value));
  t.mock.method(Math, "random", () => 0.5);
  const env = { BACKEND_TOKEN: "test-key", SESSION_DIRECTORY: {
    prepare() { throw new Error("secret database payload and credentials"); },
  } };
  const response = await worker.fetch(new Request("https://test/v1/sessions", { headers: { Authorization: "Bearer test-key" } }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(logs, [{ service: "agent-api", event: "request_failed", stage: "list_sessions",
    errorCode: "API_UNAVAILABLE", retryable: true, httpStatus: 503 }]);
  logs.length = 0;
  assert.equal((await worker.fetch(new Request("https://test/health"), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://test/v1/sessions"), env)).status, 401);
  assert.equal(logs.length, 0);
});
