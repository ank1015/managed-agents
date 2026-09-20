import assert from "node:assert/strict";
import { test } from "node:test";
import * as api from "@managed-agents/harness-api";

test("harness API exposes contracts, not a migration engine", () => {
  assert.equal("validateMigrations" in api, false);
});
