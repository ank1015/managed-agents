import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMigrations } from "@managed-agents/harness-api";

test("migrations can be empty or strictly increasing without requiring consecutive versions", () => {
  validateMigrations([]);
  validateMigrations([
    { version: 1, statements: ["CREATE TABLE counter (value INTEGER)"] },
    { version: 3, statements: ["ALTER TABLE counter ADD COLUMN label TEXT"] },
  ]);
});

test("migration ordering rejects duplicates, regressions, and invalid versions", () => {
  for (const versions of [[1, 1], [2, 1], [0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => validateMigrations(versions.map((version) => ({
      version,
      statements: ["CREATE TABLE counter (value INTEGER)"],
    }))), /positive, strictly increasing safe integers/);
  }
});

test("migration definitions require actual statements", () => {
  for (const statements of [[], [""], ["  \n  "], ["SELECT 1", ""]]) {
    assert.throws(() => validateMigrations([{ version: 1, statements }]), /nonempty SQL statements/);
  }
});
