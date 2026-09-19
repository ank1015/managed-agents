import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import type { EventBody, OperationRequest, ProviderStatusResult, ProviderSubmission } from "@managed-agents/contracts";
import type { HarnessDefinition } from "@managed-agents/harness-api";
import { SessionDriver, SessionRuntime } from "../src/index.ts";
import type { DriverStorage, OperationProvider } from "../src/index.ts";
import { RUNTIME_MIGRATIONS, MIGRATION_TABLE_SQL } from "../src/storage/schema.ts";
import { OperationStore } from "../src/storage/operations.ts";

/** Real SQLite with manually controlled asynchronous alarm boundaries. Workerd coverage lives
 * in operations.test.ts; this fixture allows interruption at individual await/commit boundaries. */
class Storage implements DriverStorage {
  db = new DatabaseSync(":memory:");
  alarm: number | null = null;
  getHook: (() => void | Promise<void>) | undefined;
  setHook: (() => void | Promise<void>) | undefined;
  afterSetHook: (() => void | Promise<void>) | undefined;
  deleteHook: (() => void | Promise<void>) | undefined;
  sql = {
    exec: (query: string, ...bindings: SQLInputValue[]) => {
      const rows = this.db.prepare(query).all(...bindings);
      return {
        toArray: () => rows,
        one: () => { assert.equal(rows.length, 1); return rows[0]; },
      };
    },
  } as unknown as SqlStorage;
  constructor() { this.db.exec("PRAGMA foreign_keys = ON"); }
  transactionSync<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT transaction_test");
    try { const result = fn(); this.db.exec("RELEASE transaction_test"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO transaction_test; RELEASE transaction_test"); throw error; }
  }
  async getAlarm(): Promise<number | null> { await this.getHook?.(); return this.alarm; }
  async setAlarm(at: number | Date): Promise<void> {
    await this.setHook?.(); this.alarm = Number(at); await this.afterSetHook?.();
  }
  async deleteAlarm(): Promise<void> { await this.deleteHook?.(); this.alarm = null; }
}

const harness: HarnessDefinition<null, EventBody> = {
  operations: [{ provider: "echo", type: "echo", version: "v1" }],
  identity: { id: "test", version: "v1" }, migrations: [], parseConfig: () => null, parseInput: e => e,
  initialize() {},
  handle(input, ctx) {
    if (input.event.type === "request") ctx.requestOperation({ provider: "echo", type: "echo", version: "v1", input: input.event.payload });
  },
};
const init = { session: { sessionId: "test", harness: harness.identity }, config: null };
const input = (id: string, type = "message") => ({ eventId: id, event: { type, payload: id } });
const immediate: OperationProvider = {
  async submit() { return { status: "completed", jobId: "job", outcome: { status: "succeeded", result: "done" } }; },
  async get() { return { status: "pending" }; },
};

function create(storage: Storage, provider = immediate, maxSteps = 10) {
  const background: Promise<unknown>[] = [];
  const driver = new SessionDriver(storage, harness, {
    providers: { echo: provider }, policy: { maxSteps },
    // Attach rejection handlers immediately to model a host observing waitUntil failures.
    waitUntil: promise => { background.push(promise.catch(error => error)); },
  });
  return { driver, async settle() { for (let i = 0; i < background.length; i++) await background[i]; } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("failed recovery alarm prevents committing initialization or input", async () => {
  const storage = new Storage();
  try {
    const { driver } = create(storage);
    storage.setHook = () => { throw new Error("alarm unavailable"); };
    await assert.rejects(driver.initialize(init), /alarm unavailable/);
    assert.equal(storage.sql.exec("SELECT * FROM runtime_session").toArray().length, 0);
    storage.setHook = undefined;
    new SessionRuntime(storage, harness).initialize(init);
    storage.setHook = () => { throw new Error("alarm unavailable"); };
    await assert.rejects(driver.appendInput(input("one")), /alarm unavailable/);
    assert.equal(storage.sql.exec("SELECT * FROM runtime_inbox").toArray().length, 0);
  } finally { storage.db.close(); }
});

test("interruption after pre-arm but before commit leaves only a harmless alarm", async () => {
  const storage = new Storage();
  try {
    const { driver } = create(storage);
    storage.afterSetHook = () => { throw new Error("interrupted"); };
    await assert.rejects(driver.initialize(init), /interrupted/);
    assert.ok(storage.alarm !== null);
    assert.equal(storage.sql.exec("SELECT * FROM runtime_session").toArray().length, 0);
    storage.afterSetHook = undefined;
    storage.alarm = null; // Delivery consumes the persisted wakeup.
    await create(storage).driver.alarm();
    assert.equal(storage.alarm, null);
  } finally { storage.db.close(); }
});

test("interruption after admission commit recovers from the already established alarm", async () => {
  const storage = new Storage();
  try {
    new SessionRuntime(storage, harness).initialize(init);
    const first = create(storage);
    let reads = 0;
    storage.getHook = () => { if (++reads === 2) throw new Error("activation interrupted before progress"); };
    await first.driver.appendInput(input("one", "request"));
    await first.settle();
    assert.ok(storage.alarm !== null);
    assert.equal(storage.sql.exec("SELECT * FROM runtime_inbox WHERE consumed_at IS NULL").toArray().length, 1);
    storage.getHook = undefined;
    storage.alarm = null;
    const restarted = create(storage);
    await restarted.driver.alarm();
    assert.ok(storage.sql.exec("SELECT outcome_json FROM runtime_operations").one().outcome_json);
    assert.equal(storage.alarm, null);
  } finally { storage.db.close(); }
});

test("idle alarm clearing cannot erase the wakeup for an interleaving admission", async () => {
  const storage = new Storage();
  try {
    new SessionRuntime(storage, harness).initialize(init);
    const { driver, settle } = create(storage);
    const entered = deferred(), release = deferred();
    storage.deleteHook = async () => { entered.resolve(); await release.promise; };
    const run = driver.run();
    await entered.promise;
    const append = driver.appendInput(input("one"));
    assert.equal(storage.sql.exec("SELECT * FROM runtime_inbox").toArray().length, 0);
    storage.deleteHook = undefined;
    release.resolve(); await run; await append; await settle();
    assert.equal(storage.sql.exec("SELECT * FROM runtime_inbox WHERE consumed_at IS NOT NULL").toArray().length, 1);
    assert.equal(storage.alarm, null);
  } finally { storage.db.close(); }
});

test("a consumed alarm is replaced while submission awaits and admission remains available", async () => {
  const storage = new Storage();
  try {
    const core = new SessionRuntime(storage, harness);
    core.initialize(init); core.appendInput(input("one", "request"));
    const entered = deferred(), release = deferred();
    let submission: ProviderSubmission | undefined;
    const provider: OperationProvider = {
      async submit(value) { submission = value; entered.resolve(); await release.promise; return { status: "accepted", jobId: "job" }; },
      async get() { return { status: "pending" }; },
    };
    const { driver, settle } = create(storage, provider);
    const run = driver.run(); await entered.promise;
    storage.alarm = null;
    const alarm = driver.alarm();
    await driver.appendInput(input("two")); // Queueing admission does not wait for provider.submit.
    assert.ok(storage.alarm !== null);
    assert.equal(submission!.operationId, storage.sql.exec<{ operation_id: string }>("SELECT operation_id FROM runtime_operations").one().operation_id);
    release.resolve(); await run; await alarm; await settle();
    assert.equal(storage.sql.exec("SELECT * FROM runtime_inbox WHERE event_id = 'two' AND consumed_at IS NOT NULL").toArray().length, 1);
    const reconcile = storage.sql.exec<{ reconcile_at: number }>("SELECT reconcile_at FROM runtime_operations").one().reconcile_at;
    assert.equal(storage.alarm, reconcile);
  } finally { storage.db.close(); }
});

test("bounded progress leaves a continuation and a failed reschedule retains the watchdog", async () => {
  const storage = new Storage();
  try {
    const core = new SessionRuntime(storage, harness);
    core.initialize(init);
    for (let i = 0; i < 3; i++) core.appendInput(input(String(i)));
    const { driver } = create(storage, immediate, 1);
    let writes = 0;
    storage.setHook = () => { if (++writes === 2) throw new Error("reschedule interrupted"); };
    await assert.rejects(driver.run(), /reschedule interrupted/);
    assert.equal(storage.sql.exec("SELECT * FROM runtime_inbox WHERE consumed_at IS NOT NULL").toArray().length, 1);
    assert.ok(storage.alarm !== null);
    storage.setHook = undefined;
    storage.alarm = null;
    await driver.alarm();
    assert.equal(storage.sql.exec("SELECT * FROM runtime_inbox WHERE consumed_at IS NOT NULL").toArray().length, 2);
    assert.ok(storage.alarm !== null);
    storage.alarm = null; await driver.alarm();
    assert.equal(storage.sql.exec("SELECT * FROM runtime_inbox WHERE consumed_at IS NOT NULL").toArray().length, 3);
    assert.equal(storage.alarm, null);
  } finally { storage.db.close(); }
});

test("unapplied runtime migrations preserve retained inbox data", () => {
  const storage = new Storage();
  try {
    storage.sql.exec(MIGRATION_TABLE_SQL);
    for (const statement of RUNTIME_MIGRATIONS[0]!.statements) storage.sql.exec(statement);
    storage.sql.exec("INSERT INTO runtime_migrations VALUES ('runtime', 1, ?)", JSON.stringify(RUNTIME_MIGRATIONS[0]!.statements));
    storage.sql.exec("INSERT INTO runtime_session VALUES (1, ?, 'null', 'null', 1, 1)", JSON.stringify(init.session));
    storage.sql.exec("INSERT INTO runtime_inbox VALUES ('retained', 1, 1, ?, NULL)", JSON.stringify(input("retained").event));
    const core = new SessionRuntime(storage, harness);
    assert.equal(core.getSession().createdAt, 1);
    assert.equal(core.processNext().processed, true);
    assert.equal(storage.sql.exec("SELECT consumed_at FROM runtime_inbox WHERE event_id = 'retained'").one().consumed_at !== null, true);
    assert.equal(storage.sql.exec("SELECT * FROM runtime_migrations").toArray().length, 3);
  } finally { storage.db.close(); }
});

test("undeclared provider, type or version rolls back initialization and input transitions", () => {
  const request: OperationRequest = { provider: "echo", type: "echo", version: "v1", input: null };
  for (const field of ["provider", "type", "version"] as const) {
    for (const phase of ["initialize", "handle"] as const) {
      const storage = new Storage();
      try {
        const invalid = { ...request, [field]: "undeclared" };
        const definition: typeof harness = {
          ...harness,
          migrations: [{ version: 1, statements: ["CREATE TABLE h_state(value TEXT)"] }],
          initialize(ctx) {
            if (phase === "initialize") {
              ctx.sql.exec("INSERT INTO h_state VALUES ('before operation')").toArray();
              ctx.requestOperation(invalid);
            }
          },
          handle(_input, ctx) {
            ctx.sql.exec("INSERT INTO h_state VALUES ('before operation')").toArray();
            ctx.requestOperation(invalid);
          },
        };
        const core = new SessionRuntime(storage, definition);
        if (phase === "initialize") {
          assert.throws(() => core.initialize(init), /has not declared operation/);
          assert.equal(storage.sql.exec("SELECT * FROM runtime_session").toArray().length, 0);
        } else {
          core.initialize(init); core.appendInput(input("one"));
          assert.throws(() => core.processNext(), /has not declared operation/);
          assert.equal(storage.sql.exec("SELECT consumed_at FROM runtime_inbox").one().consumed_at, null);
        }
        for (const table of ["h_state", "runtime_operations", "runtime_outbox"]) {
          assert.equal(storage.sql.exec(`SELECT * FROM ${table}`).toArray().length, 0);
        }
      } finally { storage.db.close(); }
    }
  }
});

test("operation declarations are snapshotted, reject duplicates, and require configured adapters", () => {
  const storage = new Storage();
  try {
    const operations = [{ provider: "echo", type: "echo", version: "v1" }];
    const definition: typeof harness = { ...harness, operations };
    const core = new SessionRuntime(storage, definition);
    operations[0]!.version = "v2";
    core.initialize(init); core.appendInput(input("one", "request"));
    assert.equal(core.processNext().processed, true); // The captured v1 declaration remains valid.
    assert.throws(() => new SessionRuntime(storage, { ...harness, operations: [...operations, ...operations] }), /Duplicate harness operation/);
    assert.throws(() => new SessionDriver(storage, harness, { providers: {}, waitUntil() {} }), /Provider is not configured/);
    const inherited = Object.create({ echo: immediate }) as Record<string, OperationProvider>;
    assert.throws(() => new SessionDriver(storage, harness, { providers: inherited, waitUntil() {} }), /Provider is not configured/);
    assert.doesNotThrow(() => new SessionDriver(storage, { ...harness, operations: [] }, { providers: {}, waitUntil() {} }));
  } finally { storage.db.close(); }
});

test("acceptance and input deletion commit together; stale responses cannot resurrect the outbox", () => {
  const storage = new Storage();
  try {
    const core = new SessionRuntime(storage, harness);
    core.initialize(init); core.appendInput(input("one", "request")); core.processNext();
    const store = new OperationStore(storage), now = Date.now();
    const action = store.claim(now, 1000)!;
    assert.equal(action.kind, "submit");
    const original = storage.sql.exec("SELECT * FROM runtime_outbox").toArray();
    storage.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON runtime_outbox BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END");
    assert.throws(() => store.submitted(action, { status: "accepted", jobId: "job" }, now, 10), /cleanup failed/);
    assert.equal(core.getOperation(action.operationId).jobId, null);
    assert.deepEqual(storage.sql.exec("SELECT * FROM runtime_outbox").toArray(), original);
    storage.db.exec("DROP TRIGGER fail_delete");
    store.submitted(action, { status: "accepted", jobId: "job" }, now, 10);
    assert.equal(core.getOperation(action.operationId).jobId, "job");
    assert.equal("request" in core.getOperation(action.operationId), false);
    assert.equal(storage.sql.exec("SELECT * FROM runtime_outbox").toArray().length, 0);
    const columns = storage.sql.exec<{ name: string }>("PRAGMA table_info(runtime_operations)").toArray().map(row => row.name);
    assert.equal(columns.includes("request_json"), false);
    assert.equal(columns.includes("input_json"), false);
    store.retry(action, now + 1, "late timeout");
    store.submitted(action, { status: "accepted", jobId: "different" }, now, 10);
    assert.equal(core.getOperation(action.operationId).jobId, "job");
    const status = store.claim(now + 10, 1000)!;
    assert.equal(status.kind, "status");
    assert.equal("request" in status, false);
    assert.equal("input" in status, false);
    store.reconciled(status, { status: "pending" }, now + 10, 10);
    store.retry(status, now + 100, "stale status timeout");
    assert.equal(core.getOperation(action.operationId).reconcileError, null);
    assert.equal(storage.sql.exec("SELECT * FROM runtime_outbox").toArray().length, 0);
  } finally { storage.db.close(); }
});

test("missing accepted jobs and status errors retry queries without input or resubmission", async () => {
  const storage = new Storage();
  try {
    const core = new SessionRuntime(storage, harness);
    core.initialize(init); core.appendInput(input("one", "request"));
    // Persist the request before the driver's single-step slice. A transition can
    // allocate a due_at later than that slice's captured clock, deferring submission.
    core.processNext();
    let submits = 0, gets = 0;
    let result: ProviderStatusResult = { status: "missing" };
    let error: string | undefined;
    const provider: OperationProvider = {
      async submit() { submits++; return { status: "accepted", jobId: "job" }; },
      async get(query) {
        gets++;
        assert.deepEqual(Object.keys(query).sort(), ["jobId", "operationId", "submissionId"]);
        if (error) throw new Error(error);
        return result;
      },
    };
    const { driver } = create(storage, provider, 1);
    await driver.run();
    const id = storage.sql.exec<{ operation_id: string }>("SELECT operation_id FROM runtime_operations").one().operation_id;
    async function query() {
      storage.sql.exec("UPDATE runtime_operations SET reconcile_at = 0");
      await driver.run();
      assert.equal(submits, 1);
      assert.equal(storage.sql.exec("SELECT * FROM runtime_outbox").toArray().length, 0);
    }
    await query();
    assert.match(driver.getOperation(id).reconcileError!, /missing accepted job/);
    assert.equal(driver.getOperation(id).outcome, null);
    assert.ok(storage.alarm !== null);
    error = "x".repeat(3000);
    await query();
    assert.equal(driver.getOperation(id).reconcileError!.length, 2048);
    error = undefined; result = { status: "pending" };
    await query();
    assert.equal(driver.getOperation(id).reconcileError, null);
    result = { status: "completed", outcome: { status: "succeeded", result: "done" } };
    await query();
    assert.deepEqual(driver.getOperation(id).outcome, result.outcome);
    assert.equal(gets, 4);
  } finally { storage.db.close(); }
});
