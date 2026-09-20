import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inputHash } from "../src/input-hash.ts";

test("inbox fingerprints are canonical SHA-256, including Unicode and JSON edge cases", () => {
  const event = { type: "message", payload: { z: ["😀", "\ud800", null, true, -0], a: "hello\n" } };
  const canonical = '{"payload":{"a":"hello\\n","z":["😀","\\ud800",null,true,0]},"type":"message"}';
  const expected = createHash("sha256").update(canonical).digest("hex");
  assert.equal(inputHash(event), expected);
  assert.equal(inputHash({ ...event, payload: { a: "hello\n", z: ["😀", "\ud800", null, true, 0] } }), expected);
  assert.notEqual(inputHash({ ...event, type: "other" }), expected);
  assert.notEqual(inputHash({ ...event, payload: { a: "hello\n", z: ["\ud800", "😀", null, true, 0] } }), expected);
});
