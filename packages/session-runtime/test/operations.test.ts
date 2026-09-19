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
import type { OperationInfo, ProcessingStatus } from "../src/index.ts";
import type { DeliveryAction } from "../src/storage/operations.ts";

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
async function operation(c: Client): Promise<OperationInfo> {
  const rows = await c.sql<{ operation_id: string }>("SELECT operation_id FROM runtime_operations ORDER BY created_at LIMIT 1");
  return c.call("operation", rows[0]!.operation_id);
}
function completion(op: OperationInfo): OperationCompletion {
  return { operationId: op.operationId, submissionId: op.submissionId, provider: "echo", jobId: "job-1", outcome: { status: "succeeded", result: "echo" } };
}
test("8 MiB request and outcome chunks survive restart, atomic cleanup and duplicate completions", async () => {
  const path = await mkdtemp(join(tmpdir(), "runtime-chunks-"));
  let app = createMiniflare(path);
  try {
    let c = await client("large", app);
    await c.call("coreInitialize", init());
    const payload = "x".repeat(MAX_OPERATION_INPUT_BYTES - 2);
    await c.call("coreAppend", input("large", "request", payload));
    await c.call("coreProcess");
    const op = await operation(c);
    const rows = await c.sql<{ input_json: string }>("SELECT input_json FROM runtime_outbox");
    assert.match(rows[0]!.input_json, /^@sqlite-json:/);
    const chunksBefore = (await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n;
    assert.ok(chunksBefore > 100);
    await app.dispose(); app = createMiniflare(path); c = await client("large", app);
    const action = await c.call<DeliveryAction>("claim");
    assert.equal(action.kind, "submit");
    if (action.kind !== "submit") throw new Error("Expected submission.");
    assert.equal(action.request.input, payload);
    await c.sql("CREATE TRIGGER fail_cleanup BEFORE DELETE ON runtime_outbox BEGIN SELECT RAISE(ABORT, 'no cleanup'); END");
    await c.fails("submitted", { action, result: { status: "accepted", jobId: "job-1" } }, "no cleanup");
    assert.equal((await operation(c)).jobId, null);
    assert.equal((await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n, chunksBefore);
    await c.sql("DROP TRIGGER fail_cleanup");
    await c.call("submitted", { action, result: { status: "accepted", jobId: "job-1" } });
    assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
    const afterAcceptance = (await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n;
    assert.ok(afterAcceptance < chunksBefore); // Admission event is retained, request chunks are not.
    const value = completion(op);
    value.outcome = { status: "succeeded", result: "" };
    value.outcome.result = "x".repeat(MAX_OPERATION_OUTCOME_BYTES - JSON.stringify(value.outcome).length);
    await c.sql("CREATE TRIGGER fail_result BEFORE UPDATE OF outcome_json ON runtime_operations BEGIN SELECT RAISE(ABORT, 'no result'); END");
    await c.fails("coreCompletion", value, "no result");
    assert.equal((await operation(c)).outcome, null);
    assert.equal((await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n, afterAcceptance);
    await c.sql("DROP TRIGGER fail_result");
    const receipt = await c.call<CompletionReceipt>("coreCompletion", value);
    const afterCompletion = (await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n;
    await app.dispose(); app = createMiniflare(path); c = await client("large", app);
    assert.deepEqual((await operation(c)).outcome, value.outcome);
    assert.deepEqual(await c.call("coreCompletion", value), { ...receipt, duplicate: true });
    assert.equal((await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n, afterCompletion);
    await c.fails("coreCompletion", { ...value, outcome: { status: "succeeded", result: "changed" } }, "COMPLETION_CONFLICT");
    await c.call("coreProcess");
    assert.deepEqual(await c.call("harnessResult", op.operationId), value.outcome);
    const max = (await c.sql<{ n: number }>("SELECT MAX(length(CAST(content AS BLOB))) AS n FROM runtime_json_chunks"))[0]!.n;
    assert.ok(max <= 3 * 65_536);
  } finally { await app.dispose(); await rm(path, { recursive: true, force: true }); }
});

test("large uncommitted request chunks roll back and early completion removes only request chunks", async () => {
  const c = await client("large-rollback");
  await c.call("coreInitialize", init());
  await c.call("coreAppend", input("large", "fail-request", "😀".repeat(800_000)));
  const before = (await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n;
  await c.fails("coreProcess", undefined, "request handler failed");
  assert.equal((await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n, before);
  await c.call("settings", { fixed: true }); await c.call("coreProcess");
  const op = await operation(c); await c.call("coreCompletion", completion(op));
  assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
  assert.equal((await c.sql<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_json_chunks"))[0]!.n, before);
});
async function complete(c: Client) {
  await eventually(() => c.sql("SELECT outcome_json FROM runtime_operations"), rows => rows.some(row => row.outcome_json !== null));
  return operation(c);
}

test("request operations share the harness transaction, initialization, causal identity and context lifetime", async () => {
  const c = await client("atomic");
  await c.call("coreInitialize", init());
  await c.call("coreAppend", input("bad", "fail-request"));
  await c.fails("coreProcess", undefined, "request handler failed");
  for (const table of ["runtime_operations", "runtime_outbox", "h_pending", "h_events"]) {
    assert.deepEqual(await c.sql(`SELECT * FROM ${table}`), []);
  }
  await c.fails("expired", undefined, "expired");
  await c.call("settings", { fixed: true });
  await c.call("coreProcess");
  const first = await operation(c);
  assert.equal(first.causedByEventId, "bad");
  assert.equal(first.version, "v1");
  assert.equal("request" in first, false);
  assert.deepEqual(JSON.parse((await c.sql<{ input_json: string }>("SELECT input_json FROM runtime_outbox"))[0]!.input_json), { mode: "immediate" });
  assert.equal(first.outcome, null);
  await c.call("coreAppend", input("second")); await c.call("coreProcess");
  assert.equal((await c.sql("SELECT * FROM runtime_operations")).length, 2);
  assert.equal((await c.sql("SELECT * FROM runtime_outbox")).length, 2);
  const initialized = await client("init-operation");
  await initialized.call("settings", { failInitialize: true });
  await initialized.fails("coreInitialize", init("request"));
  assert.deepEqual(await initialized.sql("SELECT * FROM runtime_operations"), []);
  await initialized.call("settings", {});
  await initialized.call("initialize", init("request"));
  await complete(initialized);
  assert.equal((await operation(initialized)).causedByEventId, null);
});

test("completion admission correlates early callbacks, deduplicates and prevents spoofed events", async () => {
  const c = await client("completion-contract");
  await c.call("coreInitialize", init());
  await c.call("coreAppend", input("one")); await c.call("coreProcess");
  const op = await operation(c), value = completion(op);
  await c.fails("coreCompletion", { ...value, operationId: "unknown" }, "OPERATION_NOT_FOUND");
  await c.fails("coreCompletion", { ...value, submissionId: "wrong" }, "COMPLETION_CONFLICT");
  await c.fails("coreCompletion", { ...value, provider: "other" }, "COMPLETION_CONFLICT");
  await c.fails("coreAppend", { eventId: "spoof", event: { type: "runtime.operation.completed", payload: value } }, "INVALID_INPUT");
  await c.fails("coreAppend", input("runtime:operation:spoof"), "INVALID_INPUT");
  const first = await c.call<CompletionReceipt>("coreCompletion", value);
  assert.equal(first.duplicate, false);
  assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
  assert.deepEqual(await c.call("coreCompletion", value), { ...first, duplicate: true });
  await c.fails("coreCompletion", { ...value, jobId: "wrong" }, "COMPLETION_CONFLICT");
  await c.fails("coreCompletion", { ...value, outcome: { status: "cancelled" } }, "COMPLETION_CONFLICT");
  assert.equal((await c.sql("SELECT * FROM runtime_inbox")).length, 2);
  await c.call("coreProcess");
  assert.deepEqual(await c.call("coreCompletion", value), { ...first, duplicate: true });
  assert.notEqual((await c.sql("SELECT result_json FROM h_pending"))[0]!.result_json, null);
});

test("completion outcome and inbox entry commit atomically and survive handler failure", async () => {
  const c = await client("completion-rollback");
  await c.call("coreInitialize", init()); await c.call("coreAppend", input("one")); await c.call("coreProcess");
  const value = completion(await operation(c));
  await c.sql("CREATE TRIGGER fail_inbox BEFORE INSERT ON runtime_inbox BEGIN SELECT RAISE(ABORT, 'no inbox'); END");
  await c.fails("coreCompletion", value, "no inbox");
  assert.equal((await operation(c)).outcome, null);
  assert.equal((await c.sql("SELECT state FROM runtime_outbox"))[0]!.state, "pending");
  await c.sql("DROP TRIGGER fail_inbox"); await c.call("coreCompletion", value);
  await c.call("settings", { failCompletion: true });
  await c.fails("coreProcess", undefined, "completion handler failed");
  assert.deepEqual((await operation(c)).outcome, value.outcome);
  assert.equal((await c.sql("SELECT result_json FROM h_pending"))[0]!.result_json, null);
});

test("expired attempt tokens fence stale acknowledgements and callbacks take precedence", async () => {
  const c = await client("stale-attempt");
  await c.call("coreInitialize", init()); await c.call("coreAppend", input("one")); await c.call("coreProcess");
  const old = await c.call<DeliveryAction>("claim");
  await c.sql("UPDATE runtime_outbox SET due_at = 0");
  const current = await c.call<DeliveryAction>("claim");
  assert.notEqual(old.token, current.token);
  assert.equal(old.submissionId, current.submissionId);
  await c.call("submitted", { action: old, result: { status: "accepted", jobId: "stale" } });
  assert.equal((await operation(c)).jobId, null);
  await c.call("coreCompletion", completion(await operation(c)));
  await c.call("submitted", { action: current, result: { status: "accepted", jobId: "late" } });
  assert.equal((await operation(c)).jobId, "job-1");
  assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
});

for (const mode of ["immediate", "lost", "transient", "early", "early-rejected", "status-transient", "missing", "timeout"]) {
  test(`automatic progress completes ${mode} delivery with one logical job and completion`, async () => {
    const name = `automatic-${mode}`, c = await client(name);
    await c.call("initialize", init());
    await c.call("append", input("one", "request", { mode, sessionName: name }));
    const op = await complete(c);
    const provider = await client("provider", mf, "PROVIDERS");
    const jobs = await provider.call<{ submission_id: string; submits: number }[]>("jobs");
    const matches = jobs.filter(j => j.submission_id === op.submissionId);
    assert.equal(matches.length, 1);
    if (["lost", "timeout"].includes(mode)) assert.ok(matches[0]!.submits >= 2);
    if (["missing", "status-transient"].includes(mode)) assert.equal(matches[0]!.submits, 1);
    assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
    if (mode === "transient") {
      const calls = await provider.call<{ submission_id: string; calls: number }[]>("calls");
      assert.equal(calls.find(c => c.submission_id === op.submissionId)!.calls, 3);
      assert.equal(matches[0]!.submits, 1);
    }
    await eventually(() => c.call("alarm"), alarm => alarm === null);
  });
}

test("definitive rejection is a terminal submission failure rather than an uncertain retry", async () => {
  const c = await client("rejected");
  await c.call("initialize", init()); await c.call("append", input("one", "request", { mode: "reject" }));
  await complete(c);
  assert.deepEqual((await operation(c)).outcome, { status: "failed", origin: "submission", error: { code: "REJECTED", message: "Definitive rejection" } });
  assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
});

test("new input during awaited submission is durably retained and processed", async () => {
  const c = await client("interleaved");
  await c.call("initialize", init()); await c.call("append", input("one", "request", { mode: "delay" }));
  await eventually(() => c.sql("SELECT state FROM runtime_outbox"), rows => rows[0]?.state === "submitting");
  await c.call("append", input("two", "record", "arrived during submit"));
  await complete(c);
  assert.equal((await c.sql("SELECT * FROM h_events WHERE event_id = 'two'")).length, 1);
});

test("bounded slices continue by alarm and a poisoned input blocks without losing later inputs", async () => {
  const c = await client("budget");
  await c.call("coreInitialize", init());
  for (let i = 0; i < 15; i++) await c.call("coreAppend", input(`input-${i}`, "record", i));
  await c.call("run");
  await eventually(() => c.sql("SELECT * FROM h_events"), rows => rows.length === 15);
  const blocked = await client("blocked");
  await blocked.call("initialize", init());
  await blocked.call("append", input("bad", "fail")); await blocked.call("append", input("later", "record"));
  const progress = await eventually(() => blocked.call<ProcessingStatus>("progress"), p => p.blocked);
  assert.equal(progress.failures, 3); assert.equal(progress.pendingEventId, "bad");
  assert.equal((await blocked.sql("SELECT * FROM h_events")).length, 0);
  await blocked.call("settings", { fixed: true }); await blocked.call("resume");
  await eventually(() => blocked.sql("SELECT * FROM h_events"), rows => rows.length === 2);
});

test("an accepted job with delayed completion stays queryable until reconciliation finds it", async () => {
  const c = await client("pending");
  await c.call("initialize", init()); await c.call("append", input("one", "request", { mode: "pending" }));
  await eventually(() => c.sql("SELECT job_id FROM runtime_operations"), rows => typeof rows[0]?.job_id === "string");
  assert.equal((await operation(c)).outcome, null);
  assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
  const provider = await client("provider", mf, "PROVIDERS");
  await provider.call("ready");
  await complete(c);
});

test("blocked harness processing still delivers committed operations and admits their results", async () => {
  const c = await client("blocked-with-operation");
  await c.call("coreInitialize", init());
  await c.call("coreAppend", input("operation", "request", { mode: "status-transient" }));
  await c.call("coreProcess");
  await c.call("append", input("bad", "fail"));
  await eventually(() => c.call<ProcessingStatus>("progress"), p => p.blocked);
  await eventually(() => operation(c), op => op.outcome !== null);
  assert.equal((await c.sql("SELECT * FROM runtime_inbox WHERE consumed_at IS NULL")).length, 2);
  await c.call("settings", { fixed: true }); await c.call("resume");
  await complete(c);
});

test("workerd restart recovers a committed operation and interrupted accepted submission without new user input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "operation-recovery-"));
  let instance = createMiniflare(directory);
  try {
    let c = await client("persistent-operation", instance);
    await c.call("coreInitialize", init());
    // Reproduce interruption boundaries with the same pre-arm -> commit -> claim ordering as the driver.
    await c.call("arm", 1200);
    await c.call("coreAppend", input("one", "request", { mode: "lost" })); await c.call("coreProcess");
    const action = await c.call<DeliveryAction>("claim");
    assert.equal(action.kind, "submit");
    const namespace = await instance.getDurableObjectNamespace("PROVIDERS");
    const r = await namespace.get(namespace.idFromName("provider")).fetch("https://provider/", {
      method: "POST", body: JSON.stringify({ op: "submit", value: { operationId: action.operationId, submissionId: action.submissionId, request: action.request } }),
    });
    assert.equal(r.status, 503); // Provider committed; session never recorded acceptance.
    await instance.dispose();
    instance = createMiniflare(directory);
    c = await client("persistent-operation", instance);
    await complete(c); // Read-only observation; alarm is the only source of processing.
    const op = await operation(c);
    assert.equal(op.operationId, action.operationId); assert.equal(op.submissionId, action.submissionId);
    const provider = await client("provider", instance, "PROVIDERS");
    const jobs = await provider.call<{ submits: number }[]>("jobs");
    assert.equal(jobs.length, 1); assert.ok(jobs[0]!.submits >= 2);
  } finally {
    await instance.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test("workerd restart reconciles an accepted job after its request payload has been deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accepted-operation-recovery-"));
  let instance = createMiniflare(directory);
  try {
    let c = await client("accepted-operation", instance);
    await c.call("coreInitialize", init());
    await c.call("arm", 1200);
    await c.call("coreAppend", input("one", "request", { mode: "pending" }));
    await c.call("coreProcess");
    const action = await c.call<DeliveryAction>("claim");
    assert.equal(action.kind, "submit");
    let provider = await client("provider", instance, "PROVIDERS");
    const accepted = await provider.call("submit", {
      operationId: action.operationId, submissionId: action.submissionId, request: action.request,
    });
    await c.call("submitted", { action, result: accepted });
    assert.equal((await operation(c)).outcome, null);
    assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
    await instance.dispose();
    instance = createMiniflare(directory);
    c = await client("accepted-operation", instance);
    provider = await client("provider", instance, "PROVIDERS");
    await provider.call("ready");
    const op = await complete(c);
    assert.equal(op.operationId, action.operationId);
    assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
    const jobs = await provider.call<{ submits: number }[]>("jobs");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.submits, 1);
    const receipt = await c.call<CompletionReceipt>("coreCompletion", {
      operationId: op.operationId, submissionId: op.submissionId, provider: op.provider,
      jobId: op.jobId, outcome: op.outcome,
    });
    assert.equal(receipt.duplicate, true);
  } finally {
    await instance.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

for (const outcome of [
  { status: "cancelled" },
  { status: "failed", origin: "execution", error: { code: "FAILED", message: "Execution failed" } },
]) {
  test(`${outcome.status} completion deletes input and remains deduplicated`, async () => {
    const c = await client(`terminal-cleanup-${outcome.status}`);
    await c.call("coreInitialize", init());
    await c.call("coreAppend", input("one")); await c.call("coreProcess");
    const value = { ...completion(await operation(c)), outcome };
    const receipt = await c.call<CompletionReceipt>("coreCompletion", value);
    assert.deepEqual(await c.sql("SELECT * FROM runtime_outbox"), []);
    assert.deepEqual((await operation(c)).outcome, outcome);
    assert.deepEqual(await c.call("coreCompletion", value), { ...receipt, duplicate: true });
  });
}
