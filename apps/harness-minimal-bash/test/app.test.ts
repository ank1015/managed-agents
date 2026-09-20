import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, until, llmResult, bashResult, llmInput, config } from "./stack.ts";
import type { Job, Page } from "./stack.ts";

test("API routes a real minimal bash session through LLM and serial bash RPC with transcript reads and D1 statuses", async () => {
  const s = await startStack();
  try {
    const id = await s.create("flow");
    assert.deepEqual((await s.page(id)).messages, []);
    await s.db.prepare("CREATE TABLE status_audit(status TEXT)").run();
    await s.db.prepare("CREATE TRIGGER audit_status AFTER UPDATE OF status ON sessions BEGIN INSERT INTO status_audit VALUES(NEW.status); END").run();
    await s.input(id, "prompt");
    let jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 1);
    assert.equal(jobs[0]!.request.destination.routeKey, "minimal-bash-v7");
    assert.deepEqual(llmInput(jobs[0]!).providerOptions.reasoning, { effort: "medium", summary: "auto" });
    assert.match(llmInput(jobs[0]!).instructions!, /\/workspace/);
    assert.equal(llmInput(jobs[0]!).messages.some(message => message.role === "system"), false);
    await until(() => s.db.prepare("SELECT status FROM sessions WHERE session_id = ?").bind(id).first<{ status: string }>(), row => row?.status === "running");
    await s.control("/finish", { id: jobs[0]!.id, outcome: llmResult(["pwd", "ls"]) });
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 2);
    assert.deepEqual(jobs[1]!.request.submission.request.input, { command: "pwd", cwd: config.cwd, machineId: config.machineId });
    await s.input(id, "steer-1"); await s.input(id, "steer-2");
    await until(() => s.page(id), page => page.state.pendingMessageCount === 2);
    const pending = await s.request<{ messages: { eventId: string }[] }>(`/v1/sessions/${id}/pending-messages`);
    assert.deepEqual(pending.messages.map(m => m.eventId), ["steer-1", "steer-2"]);
    await s.control("/finish", { id: jobs[1]!.id, outcome: bashResult });
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 3);
    assert.equal(jobs[2]!.request.submission.request.provider, "tool-pi-bash");
    await s.control("/finish", { id: jobs[2]!.id, outcome: bashResult });
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 4);
    assert.deepEqual(llmInput(jobs[3]!).messages.slice(-2).map(m => m.role), ["user", "user"]);
    assert.ok(llmInput(jobs[3]!).messages.every(m => m.role !== "custom"));
    const firstReceipt = await s.control("/finish", { id: jobs[3]!.id, outcome: llmResult() });
    const secondReceipt = await s.control("/finish", { id: jobs[3]!.id, outcome: llmResult() });
    assert.equal(firstReceipt.ok, true); assert.equal((secondReceipt.value as { duplicate: boolean }).duplicate, true);
    const page = await until(() => s.page(id), page => page.state.status === "idle");
    assert.equal(page.messages.filter(m => m.message.role === "tool_result").length, 2);
    const one = await s.request<Page>(`/v1/sessions/${id}/messages?limit=1`); assert.equal(one.nextCursor, 1);
    assert.equal((await s.request<Page>(`/v1/sessions/${id}/messages?after=1&limit=1`)).messages[0]!.sequence, 2);
    await until(() => s.db.prepare("SELECT status FROM sessions WHERE session_id = ?").bind(id).first<{ status: string }>(), row => row?.status === "idle");
    assert.deepEqual((await s.db.prepare("SELECT status FROM status_audit ORDER BY rowid").all()).results, [{ status: "running" }, { status: "idle" }]);
  } finally { await s.app.dispose(); }
});
test("graceful cancellation finishes the current turn, persists held messages, and requires explicit resume", async () => {
  const s = await startStack(); try {
    const id = await s.create("stop"); await s.input(id, "prompt");
    let jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 1);
    const runId = (await s.page(id)).state.runId;
    await s.input(id, "cancel", "minimal_bash.cancel", { runId }); await s.input(id, "held");
    await until(() => s.page(id), page => page.state.status === "cancelling");
    await s.control("/finish", { id: jobs[0]!.id, outcome: llmResult(["one", "two"]) });
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 2);
    await s.control("/finish", { id: jobs[1]!.id, outcome: bashResult });
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 3);
    await s.control("/finish", { id: jobs[2]!.id, outcome: bashResult });
    const stopped = await until(() => s.page(id), page => page.state.status === "cancelled");
    assert.equal(stopped.state.pendingMessageCount, 1); assert.equal((await s.control<Job[]>("/jobs")).length, 3);
    await s.input(id, "resume", "minimal_bash.resume", {});
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 4);
    assert.equal(jobs[3]!.request.submission.request.provider, "llm"); assert.equal((await s.page(id)).state.pendingMessageCount, 0);
  } finally { await s.app.dispose(); }
});
test("D1 display status failure does not block execution or infer status on reads", async () => {
  const s = await startStack(); try {
    const id = await s.create("status-repair");
    await s.db.prepare("CREATE TRIGGER fail_status BEFORE UPDATE OF status ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END").run();
    await s.input(id, "prompt");
    const jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 1);
    assert.ok((await s.page(id)).state.activeOperationId);
    assert.equal((await s.db.prepare("SELECT status FROM sessions WHERE session_id = ?").bind(id).first())!.status, "idle");
    await s.db.prepare("DROP TRIGGER fail_status").run();
    assert.equal((await s.page(id)).state.status, "idle");
    const runId = (await s.page(id)).state.runId;
    await s.input(id, "cancel", "minimal_bash.cancel", { runId });
    await until(() => s.page(id), page => page.state.status === "cancelling");
    await s.control("/finish", { id: jobs[0]!.id, outcome: llmResult() });
    await until(() => s.page(id), page => page.state.status === "cancelled");
  } finally { await s.app.dispose(); }
});
test("restart preserves the active bash cursor, steering, and stable operation identity", async () => {
  const path = await mkdtemp(join(tmpdir(), "minimal-bash-restart-"));
  let s = await startStack(path);
  try {
    const id = await s.create("restart"); await s.input(id, "prompt");
    let jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 1);
    await s.control("/finish", { id: jobs[0]!.id, outcome: llmResult(["one", "two"]) });
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 2);
    await s.input(id, "steer"); await until(() => s.page(id), page => page.state.pendingMessageCount === 1);
    const operationId = (await s.page(id)).state.activeOperationId;
    await s.app.dispose(); s = await startStack(path);
    assert.equal((await s.page(id)).state.activeOperationId, operationId);
    await s.control("/finish", { id: jobs[1]!.id, outcome: bashResult });
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 3);
    await s.control("/finish", { id: jobs[2]!.id, outcome: bashResult });
    jobs = await until(() => s.control<Job[]>("/jobs"), jobs => jobs.length === 4);
    assert.equal(llmInput(jobs[3]!).messages.at(-1)?.role, "user"); assert.equal((await s.page(id)).state.pendingMessageCount, 0);
  } finally { await s.app.dispose(); await rm(path, { recursive: true, force: true }); }
});
test("validation, authentication, session isolation, and removed endpoints remain enforced", async () => {
  const s = await startStack(); try {
    const id = await s.create("validation"), other = await s.create("other");
    assert.equal((await s.app.dispatchFetch(`https://api/v1/sessions/${id}/messages`)).status, 401);
    for (const q of ["limit=0", "limit=101", "after=-1", "after=1.5", "after=", "limit=2&limit=3", "extra=1"]) await s.request(`/v1/sessions/${id}/messages?${q}`, "GET", undefined, 400);
    for (const suffix of ["", "/outputs", "/progress", "/operations/op"]) await s.request(`/v1/sessions/${id}${suffix}`, "GET", undefined, 404);
    await s.request(`/v1/sessions/${id}/inputs`, "POST", { eventId: "bad", event: { type: "minimal_bash.follow_up", payload: {} } }, 400);
    await s.input(id, "prompt"); await until(() => s.page(id), page => page.state.status === "running");
    assert.equal((await s.page(other)).state.status, "idle");
    const wrong = await s.control<{ ok: boolean }>("/internal", { sessionId: id, command: { action: "initialize", value: { session: { sessionId: other, harness: { id: "minimal-bash", version: "v7" } }, config } } });
    assert.equal(wrong.ok, false);
    const host = await s.app.getWorker("host"); assert.equal((await host.fetch("https://host/sessions/x/inputs", { method: "POST" })).status, 404);
    assert.deepEqual(await (await host.fetch("https://host/health")).json(), { ok: true, harness: { id: "minimal-bash", version: "v7" } });
    const deploy = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    assert.equal(deploy.workers_dev, false); assert.equal(deploy.preview_urls, false); assert.equal(deploy.routes, undefined);
    assert.equal(deploy.triggers, undefined);
    assert.equal(deploy.name, "managed-agents-harness-minimal-bash-v7");
  } finally { await s.app.dispose(); }
});
