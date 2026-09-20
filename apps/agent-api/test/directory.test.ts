import assert from "node:assert/strict";
import { test } from "node:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { SessionStatus } from "@managed-agents/contracts";
import { SessionDirectory } from "../src/sessions/directory.ts";

test("input/read routing selects only route and lifecycle status from the primary", async () => {
  const queries: string[] = [];
  let status: SessionStatus = "idle";
  let exists = true;
  const db = { withSession(mode: string) {
    assert.equal(mode, "first-primary");
    return { prepare(query: string) {
      queries.push(query);
      return { bind(id: string) {
        assert.equal(id, "session");
        return { async first() { return exists ? { route_key: "minimal-bash-v7", status } : null; } };
      } };
    } };
  } } as unknown as D1Database;
  const directory = new SessionDirectory(db);
  assert.deepEqual(await directory.readyEntry("session"), { route_key: "minimal-bash-v7", status: "idle" });
  status = "running";
  assert.equal((await directory.readyEntry("session")).status, "running");
  for (const blocked of ["initializing", "initialization_failed", "destroyed"] as const) {
    status = blocked;
    await assert.rejects(directory.readyEntry("session"), { code: "SESSION_NOT_READY", status: 409 });
  }
  exists = false;
  await assert.rejects(directory.readyEntry("session"), { code: "NOT_FOUND", status: 404 });
  assert.ok(queries.every(query => query === "SELECT route_key, status FROM sessions WHERE session_id = ?"));
});
