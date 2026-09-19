import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSynchronous, assertUndefined } from "../src/values.ts";

test("synchronous config can contain ordinary JSON fields named then", () => {
  for (const value of [{ then: "text" }, { then: null }, { then: { enabled: true } }]) {
    assert.doesNotThrow(() => assertSynchronous(value, "parseConfig"));
  }
});

test("promise and thenable results are rejected without starting thenable work", async () => {
  let called = false;
  assert.throws(() => assertSynchronous({ then() { called = true; } }, "parseConfig"), /synchronous/);
  assert.equal(called, false);
  assert.throws(() => assertUndefined(Promise.resolve(), "initialize"), /synchronous/);
  const rejected = Promise.reject(new Error("async failure"));
  assert.throws(() => assertUndefined(rejected, "handle"), /synchronous/);
  await Promise.resolve(); // Runtime has observed the rejection.
  assert.throws(() => assertUndefined(1, "handle"), /undefined/);
});

test("checking hook results does not execute accessors", () => {
  let called = false;
  const value = Object.defineProperty({}, "then", { get() { called = true; throw new Error("getter"); } });
  assertSynchronous(value, "parseConfig"); // JSON validation rejects accessors separately.
  assert.equal(called, false);
});
