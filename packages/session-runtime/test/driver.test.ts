import assert from "node:assert/strict";
import { Logger } from "@managed-agents/diagnostics";
import { test } from "node:test";
import type { EventBody, InputEnvelope, OperationCompletion, ProviderSubmission, ProviderSubmitResult, RuntimeEvent } from "@managed-agents/contracts";
import type { HarnessDefinition, TransitionPlan } from "@managed-agents/harness-api";
import { SessionDriver, SessionRuntime } from "../src/index.ts";
import type { DriverPolicy, OperationProvider } from "../src/index.ts";
import { Storage, deferred } from "./storage.ts";

type Changes = { eventId: string; event: EventBody };
type H = HarnessDefinition<null, EventBody, Changes>;
const def = { provider: "echo", type: "echo", version: "v1" };
const harness: H = {
  identity: { id: "test", version: "v5" }, operations: [def],
  schema: ["CREATE TABLE h_events(event_id TEXT PRIMARY KEY, event_json TEXT NOT NULL)"],
  parseConfig: () => null, parseInput: e => e, initialize() {},
  handle(input) {
    const values = input.event.type === "request" ? input.event.payload as string[] : [];
    return { changes: { eventId: input.eventId, event: input.event },
      operations: values.map(key => ({ key, ...def, input: key })) };
  },
  apply(c, ctx) { ctx.sql.exec("INSERT INTO h_events VALUES (?, ?)", c.eventId, JSON.stringify(c.event)).toArray(); },
};
const init = { session: { sessionId: "test", harness: harness.identity }, config: null };
const input = (id: string, keys?: string[]) => ({ eventId: id, event: { type: keys ? "request" : "message", payload: keys ?? id } });
const accepted = (s: ProviderSubmission): ProviderSubmitResult => ({ status: "accepted", jobId: `job-${s.operationId}` });
const completed = (s: ProviderSubmission): ProviderSubmitResult => ({ status: "completed", jobId: `job-${s.operationId}`, outcome: { status: "succeeded", result: s.request.input } });
const completion = (s: ProviderSubmission): OperationCompletion => ({ provider: "echo", operationId: s.operationId,
  submissionId: s.submissionId, jobId: `job-${s.operationId}`, outcome: { status: "succeeded", result: s.request.input } });
function create(storage: Storage, submit: OperationProvider["submit"] = async s => accepted(s), options: { harness?: H; policy?: Partial<DriverPolicy> } = {}) {
  const background: Promise<void>[] = [];
  const driver = new SessionDriver(storage, options.harness ?? harness, { providers: { echo: { submit } },
    policy: { retryBaseMs: 1, retryMaxMs: 2, ...options.policy },
    waitUntil: p => { background.push(p); void p.catch(() => {}); },
  });
  return { driver, background, async settle() { for (let i = 0; i < background.length; i++) await background[i]; } };
}
const count = (s: Storage, table = "h_events") => s.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

test("blocked transitions log safe correlation without raw errors and preserve recovery semantics", async () => {
  const storage = new Storage(), logs: Record<string, unknown>[] = [], background: Promise<void>[] = [];
  try {
    const sessionId = "ses_11111111-1111-4111-8111-111111111111";
    const driver = new SessionDriver(storage, { ...harness, handle() { throw new Error("private input or credential"); } }, {
      providers: { echo: { submit: async s => accepted(s) } }, policy: { maxHandlerFailures: 1 },
      diagnostics: new Logger("harness-host", { LOG_SUCCESS_SAMPLE_RATE: "0" }, (_level, record) => logs.push(record)),
      waitUntil: p => { background.push(p); },
    });
    await driver.initialize({ ...init, session: { ...init.session, sessionId } });
    await driver.appendInput(input("fail"));
    for (const p of background) await p;
    assert.equal(driver.getProcessingStatus().blocked, true);
    assert.deepEqual(logs, [{ service: "harness-host", event: "processing_blocked", stage: "prepare",
      errorCode: "HARNESS_TRANSITION_FAILED", sessionId, retryable: false, blocked: true, attempt: 1 }]);
    assert.equal(count(storage), 0);
  } finally { storage.db.close(); }
});

test("warm admission remains three statements; preparation writes nothing; commit consumes once", () => {
  const s = new Storage();
  try {
    const r = new SessionRuntime(s, harness); r.initialize(init); s.queries = [];
    r.appendInput(input("one")); assert.equal(s.queries.length, 3);
    s.queries = []; const p = r.prepareNext()!;
    assert.ok(s.queries.every(q => /^SELECT/.test(q)));
    assert.equal(count(s), 0); r.commit(p, []); assert.equal(count(s), 1);
    assert.throws(() => r.commit(p, []), /does not belong/);
    assert.equal(r.prepareNext(), undefined);
    const detached = r.getSession(); detached.identity.sessionId = "changed";
    assert.equal(r.getSession().identity.sessionId, "test");
  } finally { s.db.close(); }
});

test("completion admission is four statements; consumed duplicate is one read even after restart", async () => {
  const s = new Storage();
  try {
    const r = new SessionRuntime(s, harness); r.initialize(init); r.appendInput(input("one", ["a"]));
    const p = r.prepareNext()!;
    r.commit(p, p.operations.map(op => ({ operationId: op.operationId, result: accepted(op) })));
    const c = completion(p.operations[0]!);
    s.queries = [];
    r.acceptCompletion(c);
    assert.equal(s.queries.length, 4);
    assert.equal(s.queries.filter(q => /FROM runtime_inbox WHERE event_id/.test(q)).length, 1);
    const done = r.prepareNext()!; r.commit(done, []);
    for (let restart = 0; restart < 2; restart++) {
      const f = create(s); s.queries = []; s.alarmCalls = { get: 0, set: 0, delete: 0 };
      s.getHook = () => { throw new Error("A consumed duplicate must not touch alarms"); };
      assert.equal((await f.driver.acceptCompletion(c)).duplicate, true);
      assert.equal(s.queries.length, 1);
      assert.deepEqual(s.alarmCalls, { get: 0, set: 0, delete: 0 });
      assert.equal(f.background.length, 0);
      await assert.rejects(f.driver.acceptCompletion({ ...c, outcome: { status: "cancelled" } }), /changed/);
      assert.equal(f.background.length, 0);
    }
  } finally { s.db.close(); }
});

test("unconsumed duplicate after restart still arms recovery and processes; kick does not recheck alarm", async () => {
  const s = new Storage();
  try {
    const r = new SessionRuntime(s, harness); r.initialize(init); r.appendInput(input("one", ["a"]));
    const p = r.prepareNext()!;
    r.commit(p, p.operations.map(op => ({ operationId: op.operationId, result: accepted(op) })));
    const c = completion(p.operations[0]!); r.acceptCompletion(c);
    const f = create(s);
    assert.equal((await f.driver.acceptCompletion(c)).duplicate, true); await f.settle();
    assert.equal(count(s), 2);
    assert.deepEqual(s.alarmCalls, { get: 1, set: 1, delete: 1 });
    s.alarmCalls = { get: 0, set: 0, delete: 0 };
    await f.driver.alarm(); await f.settle();
    assert.deepEqual(s.alarmCalls, { get: 1, set: 1, delete: 1 }, "alarm invocation arms once, not twice");
  } finally { s.db.close(); }
});

test("completion snapshot survives alarm await; failed alarm cannot insert or acknowledge new completion", async () => {
  const s = new Storage(), entered = deferred(), release = deferred(); let submitted!: ProviderSubmission;
  try {
    const f = create(s, async op => { submitted = op; return accepted(op); });
    await f.driver.initialize(init); await f.driver.appendInput(input("one", ["a"])); await f.settle();
    s.setHook = () => { throw new Error("alarm unavailable"); };
    await assert.rejects(f.driver.acceptCompletion(completion(submitted)), /alarm unavailable/);
    assert.equal(count(s, "runtime_inbox"), 1); assert.equal(count(s), 1);
    s.setHook = async () => { entered.resolve(); await release.promise; };
    const value = completion(submitted), admitting = f.driver.acceptCompletion(value);
    await entered.promise;
    value.outcome = { status: "succeeded", result: "mutated" };
    release.resolve(); await admitting; await f.settle();
    const row = s.sql.exec<{ event_json: string }>("SELECT event_json FROM h_events ORDER BY rowid DESC LIMIT 1").one();
    assert.equal(JSON.parse(row.event_json).payload.outcome.result, "a");
    assert.equal((await f.driver.acceptCompletion(completion(submitted))).duplicate, true);
  } finally { release.resolve(); s.db.close(); }
});

test("failed completion insertion rolls back sequence and can retry without a second dedup lookup", () => {
  const s = new Storage();
  try {
    const r = new SessionRuntime(s, harness); r.initialize(init); r.appendInput(input("one", ["a"]));
    const p = r.prepareNext()!;
    r.commit(p, p.operations.map(op => ({ operationId: op.operationId, result: accepted(op) })));
    const c = completion(p.operations[0]!);
    s.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON runtime_inbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.throws(() => r.acceptCompletion(c), /injected/);
    assert.equal(s.sql.exec<{ n: number }>("SELECT MAX(sequence) AS n FROM runtime_inbox").one().n, 1);
    s.db.exec("DROP TRIGGER fail_insert");
    assert.equal(r.acceptCompletion(c).duplicate, false);
    assert.equal(s.sql.exec<{ n: number }>("SELECT MAX(sequence) AS n FROM runtime_inbox").one().n, 2);
  } finally { s.db.close(); }
});

test("many outgoing operations submit concurrently, mixed rejection commits and becomes an event", async () => {
  const s = new Storage(); let active = 0, peak = 0; const calls: string[] = [];
  try {
    const f = create(s, async op => {
      active++; peak = Math.max(peak, active); calls.push(op.request.input as string);
      await Promise.resolve(); active--;
      return op.request.input === "reject" ? { status: "rejected", error: { code: "NO", message: "Rejected" } } : completed(op);
    }, { policy: { submissionConcurrency: 2 } });
    await f.driver.initialize(init); await f.driver.appendInput(input("fanout", ["a", "b", "reject", "c", "d"])); await f.settle();
    assert.equal(peak, 2); assert.equal(calls.length, 5); assert.equal(count(s), 6);
    assert.equal(count(s, "runtime_pending_operations"), 0);
    const events = s.sql.exec<{ event_json: string }>("SELECT event_json FROM h_events").toArray().map(r => JSON.parse(r.event_json));
    assert.equal(events.filter(e => e.payload?.outcome?.origin === "submission").length, 1);
    assert.equal(s.alarm, null);
    for (const name of ["runtime_outbox", "runtime_operations", "runtime_progress"]) {
      assert.equal(s.sql.exec("SELECT name FROM sqlite_master WHERE name = ?", name).toArray().length, 0);
    }
  } finally { s.db.close(); }
});

test("partial acceptance and restart replay the same requests and identities, not external execution", async () => {
  const s = new Storage(), jobs = new Map<string, string>(); const calls: string[] = []; let lose = true;
  const submit: OperationProvider["submit"] = async op => {
    calls.push(op.operationId);
    const json = JSON.stringify(op.request); assert.equal(jobs.get(op.operationId) ?? json, json); jobs.set(op.operationId, json);
    if (op.request.input === "b" && lose) throw new Error("Acceptance response lost");
    return accepted(op);
  };
  try {
    const f = create(s, submit); await f.driver.initialize(init);
    await f.driver.appendInput(input("fanout", ["a", "b", "c"])); await f.settle();
    assert.equal(jobs.size, 3); assert.equal(count(s), 0); assert.equal(count(s, "runtime_pending_operations"), 0);
    assert.equal(f.driver.getProcessingStatus().pendingEventId, "fanout"); assert.ok(s.alarm);
    lose = false; s.due(); const restarted = create(s, submit); await restarted.driver.alarm(); await restarted.settle();
    assert.equal(jobs.size, 3); assert.equal(count(s), 1); assert.equal(count(s, "runtime_pending_operations"), 3);
    assert.deepEqual(calls.slice(0, 3), calls.slice(3)); assert.equal(s.alarm, null);
  } finally { s.db.close(); }
});

test("warm retry reuses resolved sibling receipts while retrying ambiguous submissions", async () => {
  const s = new Storage(); const calls: string[] = []; let lose = true;
  try {
    const f = create(s, async op => { calls.push(op.request.input as string); if (op.request.input === "b" && lose) throw new Error("offline"); return accepted(op); });
    await f.driver.initialize(init); await f.driver.appendInput(input("one", ["a", "b", "c"])); await f.settle();
    lose = false; s.due(); await f.driver.alarm(); await f.settle();
    assert.deepEqual(calls, ["a", "b", "c", "b"]); assert.equal(count(s), 1);
  } finally { s.db.close(); }
});

test("admission stays responsive while submissions wait; later handlers do not overtake", async () => {
  const s = new Storage(), started = deferred(), gate = deferred();
  try {
    const f = create(s, async op => { started.resolve(); await gate.promise; return accepted(op); });
    await f.driver.initialize(init); await f.driver.appendInput(input("first", ["a"])); await started.promise;
    const receipt = await f.driver.appendInput(input("second")); assert.equal(receipt.sequence, 2);
    assert.equal(count(s), 0); assert.equal(count(s, "runtime_inbox"), 2);
    gate.resolve(); await f.settle();
    assert.deepEqual(s.sql.exec<{ event_id: string }>("SELECT event_id FROM h_events ORDER BY rowid").toArray().map(r => r.event_id), ["first", "second"]);
  } finally { gate.resolve(); s.db.close(); }
});

test("early callback can be durably admitted inside submit without deadlock or overtaking", async () => {
  const s = new Storage(); let f: ReturnType<typeof create>; let early: OperationCompletion | undefined;
  try {
    f = create(s, async op => {
      early = completion(op);
      const receipt = await f.driver.acceptCompletion(early); assert.equal(receipt.duplicate, false);
      assert.equal(count(s), 0);
      assert.equal((await f.driver.acceptCompletion(early)).duplicate, true);
      return accepted(op);
    });
    await f.driver.initialize(init); await f.driver.appendInput(input("first", ["a"])); await f.settle();
    assert.equal(count(s), 2); assert.equal(count(s, "runtime_pending_operations"), 0);
    assert.equal((await f.driver.acceptCompletion(early!)).duplicate, true); await f.settle();
    await assert.rejects(f.driver.acceptCompletion({ ...early, jobId: "wrong" }), /changed/);
    assert.equal(count(s), 2);
  } finally { s.db.close(); }
});

test("cold early callback reconstructs the original head plan and remains behind it", () => {
  const s = new Storage();
  try {
    let r = new SessionRuntime(s, harness); r.initialize(init); r.appendInput(input("first", ["a", "b"]));
    const old = r.prepareNext()!, c = completion(old.operations[0]!);
    r = new SessionRuntime(s, harness);
    assert.equal(r.acceptCompletion(c).duplicate, false); assert.equal(count(s), 0);
    const p = r.prepareNext()!;
    assert.deepEqual(p.operations, old.operations);
    r.commit(p, p.operations.map(op => ({ operationId: op.operationId, result: accepted(op) })));
    const next = r.prepareNext()!; assert.equal(next.input.event.type, "runtime.operation.completed");
    r.commit(next, []); assert.equal(count(s, "runtime_pending_operations"), 1);
  } finally { s.db.close(); }
});

test("atomic local commit failure preserves input, receipts and all prior harness data", async () => {
  const s = new Storage(); let submits = 0;
  try {
    const f = create(s, async op => { submits++; return accepted(op); });
    await f.driver.initialize(init);
    s.db.exec("CREATE TRIGGER fail_consume BEFORE UPDATE OF consumed_at ON runtime_inbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await f.driver.appendInput(input("first", ["a"])); await f.settle();
    assert.equal(count(s), 0); assert.equal(count(s, "runtime_pending_operations"), 0); assert.equal(submits, 1);
    s.db.exec("DROP TRIGGER fail_consume"); s.due(); await f.driver.alarm(); await f.settle();
    assert.equal(count(s), 1); assert.equal(count(s, "runtime_pending_operations"), 1); assert.equal(submits, 1);
  } finally { s.db.close(); }
});

for (const kind of ["duplicate-keys", "undeclared", "write", "async", "invalid-later-operation"]) test(`invalid preparation ${kind} sends no operations`, async () => {
  const s = new Storage(); let submits = 0;
  try {
    const bad: H = { ...harness, handle(input, ctx) {
      if (kind === "write") ctx.sql.exec("INSERT INTO h_events VALUES ('x', '{}')");
      if (kind === "async") return Promise.resolve(null) as unknown as TransitionPlan<Changes>;
      const p = harness.handle(input, ctx);
      if (kind === "duplicate-keys") p.operations = [...p.operations, p.operations[0]!];
      if (kind === "undeclared") p.operations = [{ ...p.operations[0]!, provider: "not-allowed" }];
      if (kind === "invalid-later-operation") p.operations = [...p.operations, { key: "bad", ...def, input: undefined as never }];
      return p;
    } };
    const f = create(s, async op => { submits++; return accepted(op); }, { harness: bad, policy: { maxHandlerFailures: 1 } });
    await f.driver.initialize(init); await f.driver.appendInput(input("first", ["a"])); await f.settle();
    assert.equal(submits, 0); assert.equal(count(s), 0); assert.equal(f.driver.getProcessingStatus().blocked, true);
  } finally { s.db.close(); }
});

test("transport timeouts stay retryable beyond handler failure budget; late acceptance does not commit", async () => {
  const s = new Storage(), gate = deferred<ProviderSubmitResult>(); let op: ProviderSubmission | undefined;
  try {
    const f = create(s, async value => { op = value; return gate.promise; }, { policy: { providerTimeoutMs: 5, maxHandlerFailures: 1 } });
    await f.driver.initialize(init); await f.driver.appendInput(input("one", ["a"])); await f.settle();
    assert.equal(f.driver.getProcessingStatus().blocked, false); assert.equal(count(s), 0);
    gate.resolve(accepted(op!)); await Promise.resolve(); assert.equal(count(s), 0);
    s.due(); await f.driver.alarm(); await f.settle(); assert.equal(count(s), 1);
  } finally { s.db.close(); }
});

test("initialization is local-only; a failed admission alarm cannot acknowledge unprotected input", async () => {
  const s = new Storage();
  try {
    s.getHook = () => { throw new Error("alarm unavailable"); };
    const f = create(s); await f.driver.initialize(init); assert.equal(s.alarm, null);
    await assert.rejects(f.driver.appendInput(input("one")), /alarm unavailable/);
    assert.equal(count(s, "runtime_inbox"), 0);
    s.getHook = undefined; const gate = deferred(); s.getHook = () => gate.promise;
    const value = input("one"), promise = f.driver.appendInput(value); value.event.payload = "mutated";
    gate.resolve(); await promise; await f.settle();
    assert.equal((await f.driver.appendInput(input("one"))).duplicate, true); await f.settle();
  } finally { s.db.close(); }
});

test("acceptance with no remaining inbox work clears alarms: no per-operation polling", async () => {
  const s = new Storage();
  try {
    const f = create(s); await f.driver.initialize(init); await f.driver.appendInput(input("one", ["a"])); await f.settle();
    assert.equal(count(s, "runtime_pending_operations"), 1); assert.equal(s.alarm, null);
    assert.ok(s.queries.every(q => !/runtime_progress|runtime_outbox|runtime_operations/.test(q)));
  } finally { s.db.close(); }
});

test("completion correlation covers provider, job, session and full outcome after payload cleanup", () => {
  const s = new Storage();
  try {
    const r = new SessionRuntime(s, harness); r.initialize(init); r.appendInput(input("one", ["a"]));
    const p = r.prepareNext()!; r.commit(p, p.operations.map(op => ({ operationId: op.operationId, result: accepted(op) })));
    const c = completion(p.operations[0]!);
    assert.throws(() => r.acceptCompletion({ ...c, provider: "other" }), /differs/);
    assert.throws(() => r.acceptCompletion({ ...c, jobId: "other" }), /differs/);
    assert.throws(() => r.acceptCompletion({ ...c, submissionId: "other" }), /identity/);
    r.acceptCompletion(c); const done = r.prepareNext()!; r.commit(done, []);
    assert.equal(r.acceptCompletion(c).duplicate, true);
    assert.throws(() => r.acceptCompletion({ ...c, outcome: { status: "cancelled" } }), /changed/);
    const other = new Storage();
    try {
      const r2 = new SessionRuntime(other, harness); r2.initialize({ ...init, session: { ...init.session, sessionId: "other" } }); r2.appendInput(input("one", ["a"]));
      assert.throws(() => r2.acceptCompletion(c), /no pending/);
    } finally { other.db.close(); }
  } finally { s.db.close(); }
});

test("operation keys are namespaced and stable even when independent operations reorder", () => {
  const s = new Storage(); let reverse = false;
  try {
    const h: H = { ...harness, handle(i, c) { const p = harness.handle(i, c); return { ...p, operations: reverse ? [...p.operations].reverse() : p.operations }; } };
    let r = new SessionRuntime(s, h); r.initialize(init); r.appendInput(input("one", ["a", "😀".repeat(900)]));
    const first = r.prepareNext()!.operations; reverse = true; r = new SessionRuntime(s, h);
    const second = r.prepareNext()!.operations;
    assert.deepEqual(first.map(o => o.operationId), second.map(o => o.operationId).reverse());
    assert.ok(first.every(o => o.operationId.length < 150 && o.operationId === o.submissionId));
  } finally { s.db.close(); }
});

test("apply failures cannot consume completion or remove pending receipt", () => {
  const s = new Storage();
  try {
    const r = new SessionRuntime(s, harness); r.initialize(init); r.appendInput(input("one", ["a"]));
    const p = r.prepareNext()!; r.commit(p, p.operations.map(op => ({ operationId: op.operationId, result: accepted(op) })));
    r.acceptCompletion(completion(p.operations[0]!));
    const done = r.prepareNext()!;
    s.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON runtime_pending_operations BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.throws(() => r.commit(done, []), /injected/);
    assert.equal(count(s), 1); assert.equal(count(s, "runtime_pending_operations"), 1);
    s.db.exec("DROP TRIGGER fail_delete"); r.commit(done, []); assert.equal(count(s), 2);
  } finally { s.db.close(); }
});

test("partial batch early completion and steering survive restart without overtaking the unresolved source", async () => {
  const s = new Storage(); let f: ReturnType<typeof create>; let lose = true;
  const jobs = new Map<string, string>();
  const submit: OperationProvider["submit"] = async op => {
    if (op.request.input === "reject") return { status: "rejected", error: { code: "NO", message: "Rejected" } };
    const json = JSON.stringify(op.request); assert.equal(jobs.get(op.operationId) ?? json, json); jobs.set(op.operationId, json);
    if (op.request.input === "early") await f.driver.acceptCompletion(completion(op));
    if (op.request.input === "unknown" && lose) throw new Error("lost receipt");
    return accepted(op);
  };
  try {
    f = create(s, submit, { policy: { retryBaseMs: 1000, retryMaxMs: 1000 } });
    await f.driver.initialize(init); await f.driver.appendInput(input("source", ["early", "unknown", "reject"])); await f.settle();
    await f.driver.appendInput(input("steer")); await f.settle();
    assert.equal(count(s), 0); assert.equal(count(s, "runtime_inbox"), 3);
    assert.equal(count(s, "runtime_pending_operations"), 0);
    lose = false; s.due(); f = create(s, submit); await f.driver.alarm(); await f.settle();
    assert.equal(count(s), 4); assert.equal(jobs.size, 2);
    const events = s.sql.exec<{ event_id: string }>("SELECT event_id FROM h_events ORDER BY rowid").toArray().map(r => r.event_id);
    assert.equal(events[0], "source"); assert.equal(events[2], "steer");
    assert.equal(count(s, "runtime_pending_operations"), 1); assert.equal(s.alarm, null);
  } finally { s.db.close(); }
});

test("idle alarm deletion cannot erase the wakeup for a concurrently arriving input", async () => {
  const s = new Storage(), deleting = deferred(), release = deferred();
  try {
    let first = true;
    s.deleteHook = async () => { if (first) { first = false; deleting.resolve(); await release.promise; } };
    const f = create(s); await f.driver.initialize(init); await f.driver.appendInput(input("one")); await deleting.promise;
    const admission = f.driver.appendInput(input("two")); release.resolve(); await admission; await f.settle();
    assert.equal(count(s), 2); assert.equal(f.driver.getProcessingStatus().pendingEventId, null); assert.equal(s.alarm, null);
  } finally { release.resolve(); s.db.close(); }
});

test("failed retry rescheduling leaves the prearmed recovery wakeup and durable source", async () => {
  const s = new Storage(); let writes = 0;
  try {
    s.setHook = () => { if (++writes > 1) throw new Error("reschedule failed"); };
    const f = create(s, async () => { throw new Error("offline"); });
    await f.driver.initialize(init); await f.driver.appendInput(input("one", ["a"]));
    await assert.rejects(f.settle(), /reschedule failed/);
    assert.ok(s.alarm); assert.equal(count(s), 0); assert.equal(f.driver.getProcessingStatus().pendingEventId, "one");
    s.setHook = undefined; s.due(); const restarted = create(s); await restarted.driver.alarm(); await restarted.settle();
    assert.equal(count(s), 1);
  } finally { s.db.close(); }
});
