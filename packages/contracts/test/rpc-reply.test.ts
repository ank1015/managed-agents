import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderSubmitReply } from "../src/index.ts";

test("submission reply isolates RPC disposal metadata without cloning its JSON payload", () => {
  let disposed = 0;
  const value = { result: { status: "completed", jobId: "job", outcome: { status: "succeeded", result: { large: "payload" } } },
    [Symbol.dispose]() { disposed++; } };
  const parsed = parseProviderSubmitReply(value);
  assert.deepEqual(parsed, value.result); assert.equal(disposed, 1);
  if (parsed.status === "completed" && parsed.outcome.status === "succeeded") assert.equal(parsed.outcome.result, value.result.outcome.result);
});
test("malformed RPC submission results remain errors and always dispose the reply", () => {
  let disposed = 0, accessed = false;
  for (const result of [null, { status: "accepted" }, { status: "accepted", jobId: "job", extra: true }]) {
    assert.throws(() => parseProviderSubmitReply({ result, [Symbol.dispose]() { disposed++; } }));
  }
  assert.throws(() => parseProviderSubmitReply({ get result() { accessed = true; return {}; }, [Symbol.dispose]() { disposed++; } }));
  assert.equal(accessed, false); assert.equal(disposed, 4);
});
