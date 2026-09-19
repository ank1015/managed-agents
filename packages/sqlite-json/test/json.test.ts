import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import { deleteJson, jsonChunksSchema, readJson, storedJsonBytes, writeJson } from "../src/index.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query: string, ...bindings: SQLInputValue[]) {
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  db.exec(jsonChunksSchema("chunks"));
  return { db, sql, count: () => Number(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!.n) };
}
test("small JSON remains inline and user content cannot spoof a manifest", () => {
  const f = fixture(); try {
    for (const value of [null, 1, { a: "b" }, "@sqlite-json:1:fake:1:300000"]) {
      const stored = writeJson(f.sql, "chunks", value);
      assert.equal(stored, JSON.stringify(value)); assert.deepEqual(readJson(f.sql, "chunks", stored), value);
      deleteJson(f.sql, "chunks", stored);
    }
    assert.equal(f.count(), 0);
    assert.throws(() => jsonChunksSchema("chunks; DROP TABLE chunks"), /identifier/);
  } finally { f.db.close(); }
});
test("8 MiB Unicode JSON round-trips with bounded rows and independently owned references", () => {
  const f = fixture(); try {
    const value = "a".repeat(65_534) + "😀中".repeat(1_100_000) + "\ud800";
    const stored = writeJson(f.sql, "chunks", value), second = writeJson(f.sql, "chunks", value);
    assert.notEqual(stored, second);
    assert.equal(storedJsonBytes(stored), new TextEncoder().encode(JSON.stringify(value)).byteLength);
    assert.equal(readJson(f.sql, "chunks", stored), value);
    assert.ok(Number(f.db.prepare("SELECT MAX(length(CAST(content AS BLOB))) AS n FROM chunks").get()!.n) <= 3 * 65_536);
    const count = f.count(); deleteJson(f.sql, "chunks", stored); assert.equal(f.count(), count / 2);
    assert.equal(readJson(f.sql, "chunks", second), value);
    deleteJson(f.sql, "chunks", second); assert.equal(f.count(), 0);
  } finally { f.db.close(); }
});
test("chunk mutations share the caller's transaction and roll back without orphan data", () => {
  const f = fixture(); try {
    f.db.exec("BEGIN"); const stored = writeJson(f.sql, "chunks", "x".repeat(3_000_000));
    assert.ok(f.count() > 0); f.db.exec("ROLLBACK"); assert.equal(f.count(), 0);
    assert.throws(() => readJson(f.sql, "chunks", stored), /Incomplete/);
    f.db.exec("BEGIN"); const retained = writeJson(f.sql, "chunks", "x".repeat(3_000_000)); f.db.exec("COMMIT");
    const count = f.count(); f.db.exec("BEGIN"); deleteJson(f.sql, "chunks", retained); f.db.exec("ROLLBACK");
    assert.equal(f.count(), count); assert.equal(readJson<string>(f.sql, "chunks", retained).length, 3_000_000);
  } finally { f.db.close(); }
});
test("missing, misordered and oversized chunks fail closed", () => {
  const f = fixture(); try {
    const stored = writeJson(f.sql, "chunks", "x".repeat(300_000));
    f.db.exec("DELETE FROM chunks WHERE part = 1");
    assert.throws(() => readJson(f.sql, "chunks", stored), /Corrupt/);
    assert.throws(() => readJson(f.sql, "chunks", "@sqlite-json:1:bad"), /manifest/);
    assert.throws(() => writeJson(f.sql, "chunks", "x".repeat(10 * 1024 * 1024)), /envelope limit/);
  } finally { f.db.close(); }
});
