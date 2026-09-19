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
import { migrations } from "./fixture.ts";

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

test("initialization conflicts include original config, session and harness", async () => {
  const c = await client("conflicts");
  await c.fails("initialize", request(null), "INVALID_CONFIG");
  await c.call("initialize", request());
  await c.fails("initialize", request({ label: "default" }), "INITIALIZATION_CONFLICT");
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
  assert.equal((await c.sql("SELECT * FROM runtime_migrations")).length, 4);
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
});

test("invalid admission and parser rewrites allocate nothing", async () => {
  const c = await client("invalid-input");
  await c.call("initialize", request());
  await c.fails("appendInput", { ...input("a"), sequence: 1 }, "INVALID_REQUEST");
  await c.fails("appendInput", input("a", "unsupported"), "INVALID_INPUT");
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
  await c.sql("UPDATE runtime_session SET last_input_sequence = 9007199254740990");
  assert.equal((await c.call<InputReceipt>("appendInput", input("last"))).sequence, Number.MAX_SAFE_INTEGER);
  await c.fails("appendInput", input("overflow"), /sequence exhausted/);
  await c.call("processNext");
  assert.equal(await count(c), 1);
});

test("migrations run in order once and append new versions on reconstruction", async () => {
  const c = await client("migrations");
  const extra = { version: 3, statements: ["CREATE TABLE h_extra (value INTEGER)", "INSERT INTO h_extra VALUES (7)"] };
  await c.call("initialize", request());
  await c.call("configure", { migrations: [...migrations, extra] });
  await c.call("start");
  await c.call("configure", { migrations: [...migrations, extra] });
  await c.call("start");
  assert.deepEqual(await c.sql("SELECT * FROM h_extra"), [{ value: 7 }]);
  assert.deepEqual(await c.sql("SELECT scope, version FROM runtime_migrations ORDER BY scope, version"), [
    { scope: "harness", version: 1 }, { scope: "harness", version: 3 }, { scope: "runtime", version: 1 },
    { scope: "runtime", version: 2 },
    { scope: "runtime", version: 3 },
  ]);
  assert.equal(await count(c), 0);
});

test("migration SQL and history roll back together; earlier migrations remain", async () => {
  const c = await client("migration-rollback");
  const failing = { version: 2, statements: ["CREATE TABLE h_extra (value INTEGER)", "INSERT INTO h_extra VALUES (7)", "INSERT INTO missing_table VALUES (1)"] };
  await c.call("configure", { migrations: [...migrations, failing] });
  await c.fails("start", undefined, /missing_table/);
  assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name = 'h_extra'"), []);
  assert.deepEqual(await c.sql("SELECT version FROM runtime_migrations WHERE scope = 'harness'"), [{ version: 1 }]);
  await c.call("configure", { migrations: [...migrations, { ...failing, statements: failing.statements.slice(0, 2) }] });
  await c.call("initialize", request());
  assert.deepEqual(await c.sql("SELECT * FROM h_extra"), [{ value: 7 }]);
});

test("changed, removed, inserted and downgraded migration histories fail closed", async () => {
  const c = await client("migration-drift");
  const extra = { version: 3, statements: ["CREATE TABLE h_extra (value INTEGER)"] };
  await c.call("configure", { migrations: [...migrations, extra] });
  await c.call("initialize", request());
  const histories = [
    [], migrations,
    [{ ...migrations[0]!, statements: [...migrations[0]!.statements, "SELECT 1"] }, extra],
    [...migrations, { version: 2, statements: ["SELECT 1"] }, extra],
  ];
  for (const history of histories) {
    await c.call("configure", { migrations: history });
    await c.fails("start", undefined, /Incompatible harness migration history/);
  }
  assert.deepEqual(await c.sql("SELECT version FROM runtime_migrations WHERE scope = 'harness' ORDER BY version"), [{ version: 1 }, { version: 3 }]);
  await c.sql("UPDATE runtime_migrations SET statements_json = '[]' WHERE scope = 'runtime'");
  await c.call("configure", { migrations: [...migrations, extra] });
  await c.fails("start", undefined, /Incompatible runtime migration history/);
});

test("invalid migration definitions are rejected before creating schema", async () => {
  const c = await client("invalid-migrations");
  for (const definitions of [
    [{ version: 0, statements: ["SELECT 1"] }],
    [{ version: 1, statements: [] }],
    [migrations[0], migrations[0]],
  ]) {
    await c.call("configure", { migrations: definitions });
    await c.fails("start");
    assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name LIKE 'runtime_%' OR name LIKE 'h_%'"), []);
  }
});

test("wrong harness cannot open an initialized session or run its pending migrations", async () => {
  const c = await client("wrong-harness");
  await c.call("initialize", request());
  await c.call("configure", {
    identity: { id: "different", version: "v1" },
    migrations: [...migrations, { version: 2, statements: ["CREATE TABLE h_wrong (value INTEGER)"] }],
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
    assert.equal(await count(c), 1);
    assert.deepEqual(await c.call("processNext"), { processed: true, eventId: "b", sequence: 2 });
    assert.equal(await count(c), 2);
    assert.equal((await stats(c)).configCalls, 0);
    assert.equal((await stats(c)).inputCalls, 0);
  } finally {
    await instance.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
