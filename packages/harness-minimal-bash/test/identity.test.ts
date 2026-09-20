import assert from "node:assert/strict";
import { test } from "node:test";
import { MINIMAL_BASH_IDENTITY } from "../src/index.ts";

test("minimal bash has its own immutable harness identity", () => {
  assert.deepEqual(MINIMAL_BASH_IDENTITY, { id: "minimal-bash", version: "v7" });
  assert.ok(Object.isFrozen(MINIMAL_BASH_IDENTITY));
});
