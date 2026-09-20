import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { MAX_OPERATION_INPUT_BYTES, MAX_OPERATION_OUTCOME_BYTES } from "@managed-agents/contracts";
import type { CompletionReceipt, OperationCompletion } from "@managed-agents/contracts";
import type { PendingOperation, PreparedTransition, ProcessingStatus } from "../src/index.ts";

let script: string;
let mf: Miniflare;
function createMiniflare(path?: string): Miniflare {
  return new Miniflare({
    modules: true, script, compatibilityDate: "2026-07-30",
    durableObjects: { SESSIONS: { className: "OperationsFixture", useSQLite: true }, PROVIDERS: { className: "ProviderFixture", useSQLite: true } },
    ...(path ? { durableObjectsPersist: path } : {}),
  });
}
before(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("./operations-fixture.ts", import.meta.url))], bundle: true,
    format: "esm", platform: "browser", target: "es2022", write: false });
  script = result.outputFiles[0]!.text;
  mf = createMiniflare();
});
after(async () => { await mf?.dispose(); });

async function client(name: string, instance = mf, binding = "SESSIONS") {
  const ns = await instance.getDurableObjectNamespace(binding);
  const stub = ns.get(ns.idFromName(name));
  async function raw(op: string, value?: unknown) {
    if (op === "initialize" || op === "coreInitialize") {
      const request = value as ReturnType<typeof init>;
      value = { ...request, session: { ...request.session, sessionId: name } };
    }
    return stub.fetch("https://fixture/", { method: "POST", body: JSON.stringify({ op, value }) });
  }
  return {
    async call<T = unknown>(op: string, value?: unknown): Promise<T> {
      const r = await raw(op, value); const body = await r.json();
      assert.equal(r.ok, true, JSON.stringify(body)); return body as T;
    },
    async fails(op: string, value?: unknown, match?: string) {
      const r = await raw(op, value); const body = await r.json() as { error: { code?: string; message: string } };
      assert.equal(r.ok, false, JSON.stringify(body));
      if (match) assert.ok(body.error.code === match || body.error.message.includes(match), JSON.stringify(body));
    },
    async sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
      const r = await raw("sql", { query }); assert.equal(r.ok, true); return r.json() as Promise<T[]>;
    },
  };
}
type Client = Awaited<ReturnType<typeof client>>;
const init = (config: unknown = null) => ({ session: { sessionId: "test", harness: { id: "operations-test", version: "v1" } }, config });
const input = (eventId: string, type = "request", payload: unknown = { mode: "immediate" }) => ({ eventId, event: { type, payload } });
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < end);
  assert.fail(`Condition not met: ${JSON.stringify(value)}`);
}

async function plan(c: Client) { return c.call<PreparedTransition>("prepare"); }
async function pending(c: Client) {
  return c.sql<{ operation_id: string; provider: string; job_id: string }>("SELECT * FROM runtime_pending_operations");
}
const accepted = (p: PreparedTransition) => p.operations.map(op => ({
  operationId: op.operationId, result: { status: "accepted", jobId: "job-" + op.operationId },
}));
function completion(p: PreparedTransition, result: unknown = "echo"): OperationCompletion {
  const op = p.operations[0]!;
  return { operationId: op.operationId, submissionId: op.submissionId, provider: "echo",
    jobId: "job-" + op.operationId, outcome: { status: "succeeded", result: result as never } };
}
test("8 MiB outgoing requests stay in memory; maximum inline completions survive restart and atomic cleanup", async () => {
  const path = await mkdtemp(join(tmpdir(), "runtime-replay-inline-"));
  let app = createMiniflare(path);
  try {
    let c = await client("large", app);
    await c.call("coreInitialize", init());
    const payload = "x".repeat(MAX_OPERATION_INPUT_BYTES - 2);
    await c.call("coreAppend", input("large", "request", { generateBytes: payload.length }));
    const first = await plan(c), before = await c.sql("SELECT event_json FROM runtime_inbox");
    assert.equal(first.operations[0]!.request.input, payload);
    assert.ok(JSON.stringify(before).length < 200);
    assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name LIKE '%chunks%'"), []);
    assert.deepEqual(await c.sql("SELECT name FROM sqlite_master WHERE name IN ('runtime_outbox', 'runtime_operations', 'runtime_progress')"), []);
    assert.equal((await pending(c)).length, 0); // preparation writes nothing
    await app.dispose(); app = createMiniflare(path); c = await client("large", app);
    const replay = await plan(c); assert.deepEqual(replay.operations, first.operations);
    await c.sql("CREATE TRIGGER fail_commit BEFORE INSERT ON runtime_pending_operations BEGIN SELECT RAISE(ABORT, 'fail commit'); END");
    await c.fails("commit", accepted(replay), "fail commit");
    assert.deepEqual(await c.sql("SELECT * FROM h_events"), []);
    assert.deepEqual(await c.sql("SELECT event_json FROM runtime_inbox"), before);
    await c.sql("DROP TRIGGER fail_commit"); await c.call("commit", accepted(replay));
    assert.deepEqual(await c.sql("SELECT event_json FROM runtime_inbox"), [{ event_json: null }]);
    const value = completion(replay);
    value.outcome = { status: "succeeded", result: "x".repeat(MAX_OPERATION_OUTCOME_BYTES - JSON.stringify({ status: "succeeded", result: "" }).length) };
    await c.sql("CREATE TRIGGER fail_inbox BEFORE INSERT ON runtime_inbox BEGIN SELECT RAISE(ABORT, 'fail inbox'); END");
    await c.fails("coreCompletion", value, "fail inbox");
    assert.deepEqual(await c.sql("SELECT event_json FROM runtime_inbox"), [{ event_json: null }]);
    await c.sql("DROP TRIGGER fail_inbox");
    const receipt = await c.call<CompletionReceipt>("coreCompletion", value);
    await app.dispose(); app = createMiniflare(path); c = await client("large", app);
    assert.deepEqual(await c.call("coreCompletion", value), { ...receipt, duplicate: true });
    await c.call("settings", { failCompletion: true });
    await c.fails("coreProcess", undefined, "completion apply failed");
    assert.equal((await pending(c)).length, 1);
    assert.deepEqual(await c.sql("SELECT * FROM h_results"), []);
    await c.call("settings", { fixed: true }); await c.call("coreProcess");
    assert.deepEqual(await c.call("harnessResult", replay.operations[0]!.operationId), value.outcome);
    assert.deepEqual(await pending(c), []);
    assert.deepEqual(await c.sql("SELECT event_json FROM runtime_inbox"), [{ event_json: null }, { event_json: null }]);
    assert.deepEqual(await c.call("coreCompletion", value), { ...receipt, duplicate: true });
    await c.fails("coreCompletion", { ...value, outcome: { status: "cancelled" } }, "COMPLETION_CONFLICT");
  } finally { await app.dispose(); await rm(path, { recursive: true, force: true }); }
});
test("read-only preparation failure has no local writes and expires its context", async () => {
  const c = await client("atomic");
  await c.call("coreInitialize", init()); await c.call("coreAppend", input("bad", "fail-request"));
  await c.fails("prepare", undefined, "handler failed");
  for (const table of ["runtime_pending_operations", "h_results", "h_events"]) assert.deepEqual(await c.sql("SELECT * FROM " + table), []);
  await c.fails("expired", undefined, "expired");
  await c.call("settings", { fixed: true }); const p = await plan(c);
  assert.equal(p.operations.length, 1); await c.call("commit", accepted(p));
  assert.equal((await pending(c)).length, 1);
});
test("early callback survives restart and remains behind source input until acceptance commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "early-replay-"));
  let app = createMiniflare(directory);
  try {
    let c = await client("early", app);
    await c.call("coreInitialize", init()); await c.call("coreAppend", input("one"));
    const first = await plan(c), value = completion(first);
    await app.dispose(); app = createMiniflare(directory); c = await client("early", app);
    const receipt = await c.call<CompletionReceipt>("coreCompletion", value);
    assert.equal(receipt.duplicate, false); assert.equal((await pending(c)).length, 0);
    assert.deepEqual(await c.sql("SELECT event_id FROM h_events"), []);
    const replay = await plan(c); assert.deepEqual(replay.operations, first.operations);
    await c.call("commit", accepted(replay)); await c.call("coreProcess");
    assert.deepEqual(await c.call("harnessResult", first.operations[0]!.operationId), value.outcome);
    assert.deepEqual(await c.call("coreCompletion", value), { ...receipt, duplicate: true });
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
for (const mode of ["immediate", "lost", "transient", "early", "timeout", "reject"]) {
  test("automatic replay delivery: " + mode, async () => {
    const name = "auto-" + mode, c = await client(name);
    await c.call("initialize", init()); await c.call("append", input("one", "request", { mode, sessionName: name }));
    const results = await eventually(() => c.sql<{ operation_id: string }>("SELECT * FROM h_results"), rows => rows.length === 1);
    await eventually(() => c.call("alarm"), alarm => alarm === null);
    assert.deepEqual(await pending(c), []);
    const provider = await client("provider", mf, "PROVIDERS");
    const jobs = await provider.call<{ submission_id: string; submits: number }[]>("jobs");
    const matches = jobs.filter(j => j.submission_id === results[0]!.operation_id);
    assert.equal(matches.length, mode === "reject" ? 0 : 1);
    if (["lost", "timeout"].includes(mode)) assert.ok(matches[0]!.submits >= 2);
    if (mode === "reject") assert.deepEqual(await c.call("harnessResult", results[0]!.operation_id), {
      status: "failed", origin: "submission", error: { code: "REJECTED", message: "Definitive rejection" },
    });
  });
}
test("multiple outgoing operations independently accept/reject and complete through one commit", async () => {
  const c = await client("batch"); await c.call("initialize", init());
  await c.call("append", input("many", "request", [{ mode: "lost" }, { mode: "reject" }, { mode: "immediate" }]));
  await eventually(() => c.sql("SELECT * FROM h_results"), rows => rows.length === 3);
  assert.deepEqual(await pending(c), []);
  assert.equal((await c.sql("SELECT * FROM h_events")).length, 4);
  assert.deepEqual(await c.sql("SELECT sequence FROM runtime_inbox ORDER BY sequence"),
    [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }]);
});
test("bounded slices continue by alarm and deterministic failures block without losing later inputs", async () => {
  const c = await client("budget"); await c.call("coreInitialize", init());
  for (let i = 0; i < 15; i++) await c.call("coreAppend", input("input-" + i, "record", i));
  await c.call("run"); await eventually(() => c.sql("SELECT * FROM h_events"), rows => rows.length === 15);
  const b = await client("blocked"); await b.call("initialize", init());
  await b.call("append", input("bad", "fail")); await b.call("append", input("later", "record"));
  const p = await eventually(() => b.call<ProcessingStatus>("progress"), p => p.blocked);
  assert.equal(p.failures, 3); assert.equal(p.pendingEventId, "bad");
  assert.deepEqual(await b.sql("SELECT * FROM h_events"), []);
  await b.call("settings", { fixed: true }); await b.call("resume");
  await eventually(() => b.sql("SELECT * FROM h_events"), rows => rows.length === 2);
});
test("accepted jobs sleep without polling; worker callback after restart completes them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-owned-delivery-"));
  let app = createMiniflare(directory);
  try {
    let c = await client("accepted", app); await c.call("initialize", init());
    await c.call("append", input("one", "request", { mode: "pending" }));
    const rows = await eventually(() => pending(c), rows => rows.length === 1);
    await eventually(() => c.call("alarm"), value => value === null);
    await app.dispose(); app = createMiniflare(directory); c = await client("accepted", app);
    const op = rows[0]!, value = { operationId: op.operation_id, submissionId: op.operation_id, provider: op.provider, jobId: op.job_id, outcome: { status: "succeeded", result: "worker delivery" } };
    await c.call("completion", value);
    await eventually(() => c.sql("SELECT * FROM h_results"), rows => rows.length === 1);
    const provider = await client("provider", app, "PROVIDERS");
    assert.equal((await provider.call<{ submits: number }[]>("jobs"))[0]!.submits, 1);
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
test("workerd restart replays a lost acceptance from the durable input using the same identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lost-acceptance-replay-"));
  let app = createMiniflare(directory);
  try {
    let c = await client("restart", app); await c.call("coreInitialize", init());
    await c.call("arm", 1200); await c.call("coreAppend", input("one", "request", { mode: "lost" }));
    const p = await plan(c);
    const ns = await app.getDurableObjectNamespace("PROVIDERS");
    const response = await ns.get(ns.idFromName("provider")).fetch("https://provider/", { method: "POST", body: JSON.stringify({ op: "submit", value: p.operations[0] }) });
    assert.equal(response.status, 503); assert.equal((await pending(c)).length, 0);
    await app.dispose(); app = createMiniflare(directory); c = await client("restart", app);
    // Read-only observation: the pre-armed alarm, not a user retry, drives recovery.
    await eventually(() => c.sql("SELECT * FROM h_results"), rows => rows.length === 1);
    const provider = await client("provider", app, "PROVIDERS");
    const jobs = await provider.call<{ submission_id: string; submits: number }[]>("jobs");
    assert.equal(jobs.length, 1); assert.equal(jobs[0]!.submission_id, p.operations[0]!.submissionId); assert.ok(jobs[0]!.submits >= 2);
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
