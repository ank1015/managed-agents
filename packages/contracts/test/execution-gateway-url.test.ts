import assert from "node:assert/strict";
import test from "node:test";
import { parseExecutionGatewayUrl, parseToolExecutionContext } from "../src/tool-execution.ts";

test("execution gateways are required, canonical HTTPS origins", () => {
  assert.equal(parseExecutionGatewayUrl("HTTPS://Gateway.Example:443/"), "https://gateway.example");
  assert.equal(parseExecutionGatewayUrl("https://gateway.example:8443"), "https://gateway.example:8443");
  for (const value of [undefined, null, 1, "", "gateway.example", "/gateway", "http://gateway.example",
    " https://gateway.example", "https://gateway.example\n", "https://gate way.example",
    "https://gateway.example/v1", "https://gateway.example/a/..", "https://gateway.example/?", "https://gateway.example/#",
    "https://@gateway.example", "https://gateway.example\\", "https://gateway.example\\@other.example",
    "https://gateway.example?secret=private", "https://user:private@gateway.example",
    "https://", "https://" + "a".repeat(2048)]) {
    assert.throws(() => parseExecutionGatewayUrl(value), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private"));
      return true;
    });
  }
});

test("tool execution envelopes require their own gateway, without a deployment fallback", () => {
  const context = { token: `me1.00000000-0000-4000-8000-000000000001.1.${"x".repeat(43)}`,
    runtimeGeneration: "00000000-0000-4000-8000-000000000002" };
  assert.throws(() => parseToolExecutionContext(context));
  assert.deepEqual(parseToolExecutionContext({ ...context, gatewayUrl: "https://Gateway.Example/" }),
    { ...context, gatewayUrl: "https://gateway.example" });
  assert.throws(() => parseToolExecutionContext({ ...context, gatewayUrl: "https://gateway.example", other: true }));
});
