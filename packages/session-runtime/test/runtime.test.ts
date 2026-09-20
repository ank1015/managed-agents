import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import type { InitializeSessionResult, InputReceipt, SessionInfo } from "@managed-agents/contracts";
import type { ProcessNextResult } from "../src/index.ts";
import { schema } from "./fixture.ts";

let script: string;
let mf: Miniflare;
function createMiniflare(path?: string): Miniflare {
  return new Miniflare({
    modules: true, script, compatibilityDate: "2026-07-30",
    durableObjects: { SESSIONS: { className: "RuntimeFixture", useSQLite: true } },
    ...(path ? { durableObjectsPersist: path } : {}),
  });
}
before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./fixture.ts", import.meta.url))], bundle: true,
    format: "esm", platform: "browser", target: "es2022", write: false,
  });
  script = result.outputFiles[0]!.text;
  mf = createMiniflare();
});
after(async () => { await mf?.dispose(); });

async function client(name: string, instance = mf) {
  const namespace = await instance.getDurableObjectNamespace("SESSIONS");
  const stub = namespace.get(namespace.idFromName(name));
  async function raw(op: string, value?: unknown) {
    const response = await stub.fetch("https://fixture/", { method: "POST", body: JSON.stringify({ op, value }) });
    const data: unknown = await response.json();
    return { ok: response.ok, data };
  }
  return {
    async call<T = unknown>(op: string, value?: unknown): Promise<T> {
      const response = await raw(op, value);
      assert.equal(response.ok, true, JSON.stringify(response.data));
      return response.data as T;
    },
    async fails(op: string, value?: unknown, expected?: string | RegExp) {
      const response = await raw(op, value);
      assert.equal(response.ok, false, `Expected ${op} to fail`);
      const { error } = response.data as { error: { code: string | null; message: string } };
      if (typeof expected === "string") assert.equal(error.code, expected);
      if (expected instanceof RegExp) assert.match(error.message, expected);
      return error;
    },
    async sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
      const response = await raw("sql", { query });
      assert.equal(response.ok, true, JSON.stringify(response.data));
      return response.data as T[];
    },
  };
}

const request = (config: unknown = {}) => ({ session: { sessionId: "s1", harness: { id: "fixture", version: "v1" } }, config });
const input = (eventId: string, type = "record", payload: unknown = { text: eventId }) => ({ eventId, event: { type, payload } });
type Client = Awaited<ReturnType<typeof client>>;
async function count(c: Client) { return (await c.sql<{ count: number }>("SELECT count FROM h_counter"))[0]!.count; }
async function stats(c: Client) { return c.call<{ configCalls: number; inputCalls: number; activation: string; lateError: string | null }>("stats"); }

test("uninitialized operations reject without allocating records", async () => {
  const c = await client("uninitialized");
  for (const [op, value] of [["getSession", undefined], ["appendInput", input("a")], ["processNext", undefined]] as const) {
    await c.fails(op, value, "SESSION_NOT_INITIALIZED");
  }
  assert.deepEqual(await c.sql("SELECT * FROM runtime_inbox"), []);
});

test("initialization stores defaults and retries original config without revalidating", async () => {
  const c = await client("initialize");
  const first = await c.call<InitializeSessionResult>("initialize", request({ nested: { b: 2, a: 1 } }));
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.session.config, { label: "default", settings: { enabled: true } });
  assert.ok(first.session.createdAt > 0);
  await c.call("configure", { config: "reject", labelDefault: "new-default" });
  const retry = await c.call<InitializeSessionResult>("initialize", request({ nested: { a: 1, b: 2 } }));
  assert.deepEqual(retry, { ...first, duplicate: true });
  assert.equal((await stats(c)).configCalls, 1);
  assert.equal(await count(c), 0);
});

test("initialization checks identity; API owns request-content conflicts", async () => {
  const c = await client("conflicts");
  await c.fails("initialize", request(null), "INVALID_CONFIG");
  await c.call("initialize", request());
  const duplicate = await c.call<InitializeSessionResult>("initialize", request({ label: "different" }));
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.session.config, { label: "default", settings: { enabled: true } });
  const columns = await c.sql<{ name: string }>("PRAGMA table_info(runtime_session)");
  assert.equal(columns.some(column => column.name === "original_config_json"), false);
  for (const session of [
    { ...request().session, sessionId: "other" },
    { ...request().session, harness: { id: "other", version: "v1" } },
    { ...request().session, harness: { id: "fixture", version: "v2" } },
  ]) await c.fails("initialize", { ...request(), session }, "INITIALIZATION_CONFLICT");
});

test("failed initialization rolls back session and harness state; retry succeeds", async () => {
  const c = await client("init-rollback");
  await c.call("configure", { init: "fail" });
  await c.fails("initialize", request(), /initialization failed/);
  for (const table of ["runtime_session", "h_counter"]) assert.deepEqual(await c.sql(`SELECT * FROM ${table}`), []);
  assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name = 'runtime_migrations'"), []);
  await c.fails("expired-sql", undefined, /expired/);
  await c.call("configure", {});
  await c.call("initialize", request());
  assert.equal(await count(c), 0);
});

test("async and non-undefined initialization results roll back", async () => {
  for (const mode of ["async", "return"]) {
    const c = await client(`init-${mode}`);
    await c.call("configure", { init: mode });
    await c.fails("initialize", request(), /must/);
    assert.deepEqual(await c.sql("SELECT * FROM runtime_session"), []);
    assert.deepEqual(await c.sql("SELECT * FROM h_counter"), []);
  }
});

test("config results must be synchronous JSON", async () => {
  for (const config of ["invalid", "async"]) {
    const c = await client(`config-${config}`);
    await c.call("configure", { config });
    await c.fails("initialize", request());
    assert.deepEqual(await c.sql("SELECT * FROM runtime_session"), []);
  }
});

test("admission deduplicates structurally before validation, even after consumption", async () => {
  const c = await client("dedup");
  await c.call("initialize", request());
  const original = await c.call<InputReceipt>("appendInput", input("a", "record", { a: 1, b: [2, 3] }));
  assert.equal(original.sequence, 1);
  assert.equal(original.duplicate, false);
  for (const consumed of [false, true]) {
    if (consumed) await c.call("processNext");
    await c.call("configure", { input: "reject" });
    const retry = await c.call<InputReceipt>("appendInput", input("a", "record", { b: [2, 3], a: 1 }));
    assert.deepEqual(retry, { ...original, duplicate: true });
    await c.fails("appendInput", input("a", "record", { a: 1, b: [3, 2] }), "INPUT_CONFLICT");
    await c.fails("appendInput", input("a", "fail", { a: 1, b: [2, 3] }), "INPUT_CONFLICT");
  }
  assert.equal((await stats(c)).inputCalls, 1);
  assert.equal(await count(c), 1);
  const rows = await c.sql<{ event_json: null; event_hash: string; consumed_at: number }>(
    "SELECT event_json, event_hash, consumed_at FROM runtime_inbox");
  assert.equal(rows[0]!.event_json, null);
  assert.match(rows[0]!.event_hash, /^[a-f0-9]{64}$/);
  assert.ok(rows[0]!.consumed_at > 0);
});

test("consumption atomically releases large inbox payloads; hashes retain retry identity", async () => {
  const c = await client("consumed-inline");
  await c.call("initialize", request());
  const event = input("large", "record", { text: "😀".repeat(100_000) });
  const receipt = await c.call<InputReceipt>("appendInput", event);
  const before = await c.sql("SELECT event_json FROM runtime_inbox");
  assert.deepEqual(before, [{ event_json: JSON.stringify(event.event) }]);
  assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name LIKE '%chunks%'"), []);
  await c.sql(`CREATE TRIGGER reject_consumption BEFORE UPDATE OF consumed_at ON runtime_inbox
    BEGIN SELECT RAISE(ABORT, 'consumption failed'); END`);
  await c.fails("processNext", undefined, /consumption failed/);
  assert.equal(await count(c), 0);
  assert.deepEqual(await c.sql("SELECT event_json FROM runtime_inbox"), before);
  assert.deepEqual(await c.sql("SELECT consumed_at FROM runtime_inbox"), [{ consumed_at: null }]);
  await c.sql("DROP TRIGGER reject_consumption");
  await c.call("processNext");
  assert.equal(await count(c), 1);
  assert.deepEqual(await c.sql("SELECT event_json FROM runtime_inbox"), [{ event_json: null }]);
  await c.call("configure", { input: "reject" }); // Reconstruct from retained metadata, not the payload.
  assert.deepEqual(await c.call("appendInput", event), { ...receipt, duplicate: true });
  await c.fails("appendInput", input("large", "record", { text: "changed" }), "INPUT_CONFLICT");
});

test("invalid admission and parser rewrites allocate nothing", async () => {
  const c = await client("invalid-input");
  await c.call("initialize", request());
  await c.fails("appendInput", { ...input("a"), sequence: 1 }, "INVALID_REQUEST");
  await c.fails("appendInput", input("a", "unsupported"), "INVALID_INPUT");
  await c.fails("appendInput", input("oversized", "record", { text: "😀".repeat(500_000) }), "INVALID_INPUT");
  for (const mode of ["mutate", "rewrite", "async"]) {
    await c.call("configure", { input: mode });
    await c.fails("appendInput", input("a"));
  }
  assert.deepEqual(await c.sql("SELECT * FROM runtime_inbox"), []);
  await c.call("configure", {});
  assert.equal((await c.call<InputReceipt>("appendInput", input("a"))).sequence, 1);
});

test("three distinct inputs commit three ordered transitions", async () => {
  const c = await client("ordered");
  await c.call("initialize", request({ label: "session label" }));
  for (const id of ["z", "a", "m"]) await c.call("appendInput", input(id));
  assert.equal(await count(c), 0);
  for (const [i, id] of ["z", "a", "m"].entries()) {
    assert.deepEqual(await c.call<ProcessNextResult>("processNext"), { processed: true, eventId: id, sequence: i + 1 });
    assert.equal(await count(c), i + 1);
  }
  assert.deepEqual(await c.call("processNext"), { processed: false });
  assert.deepEqual(await c.sql("SELECT event_id FROM h_messages ORDER BY rowid"), [
    { event_id: "z" }, { event_id: "a" }, { event_id: "m" },
  ]);
});

test("failure rolls back all transition writes, preserves earlier commits, and blocks later inputs", async () => {
  const c = await client("rollback");
  await c.call("initialize", request());
  await c.call("appendInput", input("before"));
  await c.call("appendInput", input("bad", "fail"));
  await c.call("appendInput", input("after"));
  await c.call("processNext");
  for (let attempt = 0; attempt < 2; attempt++) {
    await c.fails("processNext", undefined, /handler failed/);
    assert.equal(await count(c), 1);
    assert.deepEqual(await c.sql("SELECT event_id FROM h_messages"), [{ event_id: "before" }]);
    assert.deepEqual(await c.sql("SELECT event_id FROM runtime_inbox WHERE consumed_at IS NULL ORDER BY sequence"), [{ event_id: "bad" }, { event_id: "after" }]);
  }
  await c.call("configure", { fixed: true });
  assert.deepEqual(await c.call("processNext"), { processed: true, eventId: "bad", sequence: 2 });
  await c.call("processNext");
  assert.equal(await count(c), 3);
});

test("storage failure while consuming an input rolls back a successful handler", async () => {
  const c = await client("consumption-failure");
  await c.call("initialize", request());
  await c.call("appendInput", input("a"));
  await c.sql(`CREATE TRIGGER reject_consumption BEFORE UPDATE OF consumed_at ON runtime_inbox
    BEGIN SELECT RAISE(ABORT, 'consumption failed'); END`);
  await c.fails("processNext", undefined, /consumption failed/);
  assert.equal(await count(c), 0);
  assert.deepEqual(await c.sql("SELECT consumed_at FROM runtime_inbox"), [{ consumed_at: null }]);
  await c.sql("DROP TRIGGER reject_consumption");
  await c.call("processNext");
  assert.equal(await count(c), 1);
});

test("concurrent retries admit once and concurrent processing consumes once", async () => {
  const c = await client("concurrent");
  await c.call("initialize", request());
  const receipts = await Promise.all(Array.from({ length: 8 }, () => c.call<InputReceipt>("appendInput", input("a"))));
  assert.equal(receipts.filter(receipt => !receipt.duplicate).length, 1);
  assert.ok(receipts.every(receipt => receipt.sequence === 1 && receipt.receivedAt === receipts[0]!.receivedAt));
  const results = await Promise.all(Array.from({ length: 8 }, () => c.call<ProcessNextResult>("processNext")));
  assert.equal(results.filter(result => result.processed).length, 1);
  assert.equal(await count(c), 1);
});

test("config mutation, non-undefined return and reentry roll back", async () => {
  for (const type of ["mutate", "return-value", "reenter"]) {
    const c = await client(`bad-handler-${type}`);
    await c.call("initialize", request());
    await c.call("appendInput", input("a", type));
    await c.fails("processNext");
    assert.equal(await count(c), 0);
    assert.deepEqual(await c.sql("SELECT consumed_at FROM runtime_inbox"), [{ consumed_at: null }]);
    assert.deepEqual((await c.call<SessionInfo>("getSession")).config, { label: "default", settings: { enabled: true } });
  }
});

test("retained contexts expire on success and asynchronous handler rejection", async () => {
  const c = await client("retained");
  await c.call("initialize", request());
  await c.call("appendInput", input("a", "retain"));
  await c.call("processNext");
  await c.fails("expired-sql", undefined, /expired/);
  await c.call("appendInput", input("b", "late"));
  await c.fails("processNext", undefined, /must be synchronous/);
  assert.match((await stats(c)).lateError!, /expired/);
  assert.equal(await count(c), 1);
});

test("session reads return detached results", async () => {
  const c = await client("reads");
  await c.call("initialize", request());
  assert.deepEqual(await c.call("mutate-read"), await c.call("getSession"));
  assert.equal((await c.call<SessionInfo>("getSession")).identity.harness.id, "fixture");
});

test("session state and event IDs are isolated by Durable Object", async () => {
  const a = await client("isolation-a"), b = await client("isolation-b");
  await a.call("initialize", request({ label: "A" }));
  await b.call("initialize", request({ label: "B" }));
  await a.call("appendInput", input("same")); await a.call("processNext");
  await b.call("appendInput", input("same", "record", "other payload"));
  assert.equal(await count(a), 1); assert.equal(await count(b), 0);
});

test("sequence exhaustion fails atomically at the safe integer boundary", async () => {
  const c = await client("sequence-limit");
  await c.call("initialize", request());
  await c.sql(`INSERT INTO runtime_inbox (sequence, event_id, received_at, event_hash, consumed_at)
    VALUES (9007199254740990, 'retained', 0, '${"0".repeat(64)}', 0)`);
  assert.equal((await c.call<InputReceipt>("appendInput", input("last"))).sequence, Number.MAX_SAFE_INTEGER);
  await c.fails("appendInput", input("overflow"), /sequence exhausted/);
  await c.call("processNext");
  assert.equal(await count(c), 1);
});

test("inbox sequence is the rowid and session metadata has no mutable sequence counter", async () => {
  const c = await client("schema-layout");
  await c.call("initialize", request());
  assert.deepEqual((await c.sql<{ name: string }>("PRAGMA table_info(runtime_session)")).map(row => row.name),
    ["singleton", "identity_json", "config_json", "created_at"]);
  const columns = await c.sql<{ name: string; pk: number; notnull: number }>("PRAGMA table_info(runtime_inbox)");
  assert.equal(columns.find(row => row.name === "sequence")!.pk, 1);
  assert.equal(columns.find(row => row.name === "event_id")!.notnull, 1);
  assert.equal((await c.sql("PRAGMA index_list(runtime_inbox)")).length, 2); // event ID + pending subset; no sequence autoindex
  const table = (await c.sql<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'runtime_pending_operations'"))[0]!;
  assert.match(table.sql, /WITHOUT ROWID/i);
  await c.call("appendInput", input("first")); await c.call("processNext");
  await c.call("configure", {}); // discard runtime instance; only a consumed tombstone remains
  assert.equal((await c.call<InputReceipt>("appendInput", input("next"))).sequence, 2);
  assert.deepEqual(await c.sql("SELECT rowid AS storage_rowid, sequence FROM runtime_inbox ORDER BY sequence"),
    [{ storage_rowid: 1, sequence: 1 }, { storage_rowid: 2, sequence: 2 }]);
});

test("fixed schema bootstraps once without migration history or reconstruction writes", async () => {
  const c = await client("bootstrap");
  const extra = ["CREATE TABLE h_extra (value INTEGER)", "INSERT INTO h_extra VALUES (7)"];
  await c.call("configure", { schema: [...schema, ...extra] });
  await c.call("initialize", request());
  await c.sql("UPDATE h_extra SET value = 9");
  await c.call("configure", { schema: [...schema, ...extra] });
  await c.call("start");
  assert.deepEqual(await c.sql("SELECT * FROM h_extra"), [{ value: 9 }]);
  assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name = 'runtime_migrations'"), []);
  // No migration engine: edits require a new namespace, never an in-place upgrade.
  await c.call("configure", { schema: [...schema, "CREATE TABLE h_later(value INTEGER)"] });
  await c.call("start");
  assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name = 'h_later'"), []);
});

test("failed bootstrap rolls back ALL runtime and harness schema and can retry", async () => {
  const c = await client("bootstrap-rollback");
  await c.call("configure", { schema: [...schema, "INSERT INTO missing_table VALUES (1)"] });
  await c.fails("start", undefined, /missing_table/);
  assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name LIKE 'runtime_%' OR name LIKE 'h_%'"), []);
  await c.call("configure", { schema });
  await c.call("initialize", request());
  assert.equal(await count(c), 0);
});

test("wrong harness cannot open an initialized session or change its schema", async () => {
  const c = await client("wrong-harness");
  await c.call("initialize", request());
  await c.call("configure", {
    identity: { id: "different", version: "v1" },
    schema: [...schema, "CREATE TABLE h_wrong (value INTEGER)"],
  });
  await c.fails("start", undefined, "INITIALIZATION_CONFLICT");
  assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name = 'h_wrong'"), []);
});

test("full workerd restart recovers configuration, state, deduplication and pending work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-runtime-"));
  let instance = createMiniflare(directory);
  try {
    let c = await client("persistent", instance);
    const original = await c.call<InitializeSessionResult>("initialize", request({ label: "persisted" }));
    const receipt = await c.call<InputReceipt>("appendInput", input("a"));
    await c.call("processNext");
    assert.deepEqual(await c.sql("SELECT event_json FROM runtime_inbox WHERE event_id = 'a'"), [{ event_json: null }]);
    await c.call("appendInput", input("b"));
    const previousActivation = (await stats(c)).activation;
    await instance.dispose();
    instance = createMiniflare(directory);
    c = await client("persistent", instance);
    assert.notEqual((await stats(c)).activation, previousActivation);
    await c.call("configure", { config: "reject", input: "reject", labelDefault: "different" });
    assert.deepEqual(await c.call("getSession"), original.session);
    assert.deepEqual(await c.call("initialize", request({ label: "persisted" })), { ...original, duplicate: true });
    assert.deepEqual(await c.call("appendInput", input("a")), { ...receipt, duplicate: true });
    await c.fails("appendInput", input("a", "record", "changed after restart"), "INPUT_CONFLICT");
    assert.equal(await count(c), 1);
    assert.deepEqual(await c.call("processNext"), { processed: true, eventId: "b", sequence: 2 });
    assert.equal(await count(c), 2);
    assert.equal((await stats(c)).configCalls, 0);
    assert.equal((await stats(c)).inputCalls, 0);
    await c.call("configure", {});
    assert.equal((await c.call<InputReceipt>("appendInput", input("c"))).sequence, 3);
  } finally {
    await instance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
