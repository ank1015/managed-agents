import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationOutcome, JsonValue } from "@managed-agents/contracts";
import { startStack, until, llmResult, bashResult, llmInput, config } from "./stack.ts";
import type { Job } from "./stack.ts";
const fwModel = "accounts/fireworks/models/kimi-k3";
const toolCalls = [
  { id: "read", name: "read", arguments: JSON.stringify({ path: "image.png" }) },
  { id: "bash", name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
  { id: "write", name: "write", arguments: JSON.stringify({ path: "file", content: "old" }) },
  { id: "edit", name: "edit", arguments: JSON.stringify({ path: "file", edits: [{ oldText: "old", newText: "new" }] }) },
];
function response(provider: "openai" | "fireworks", tools = true): OperationOutcome {
  const content = provider === "openai" ? (tools ? toolCalls.map(c => ({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }])
    : [{ role: "assistant", content: tools ? null : "done", reasoning_content: "opaque reasoning", ...(tools ? { tool_calls: toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}) }];
  return { status: "succeeded", result: { gatewayJobId: "gateway", response: { id: "resp", modelId: provider === "openai" ? config.modelId : fwModel,
    message: { role: "assistant", provider, content: content as JsonValue[] }, stopReason: tools ? "tool_use" : "stop", durationMs: 1, timestamp: 1 } } };
}
const imageResult: OperationOutcome = { status: "succeeded", result: { content: [
  { type: "text", text: "Read image" }, { type: "image", url: "https://images.example.com/test", detail: "original" },
], isError: false, details: { image: { id: "test", url: "https://images.example.com/test" } } } };
function job(jobs: Job[], provider: string): Job { const found = jobs.find(j => j.request.submission.request.provider === provider); assert.ok(found); return found; }

for (const provider of ["openai", "fireworks"] as const) test(`${provider}: API + real host RPC dispatch all four tools, preserve images and drain steering after the batch`, async () => {
  const s = await startStack(); try {
    const id = await s.create(`flow-${provider}`, { provider, ...(provider === "fireworks" ? { modelId: fwModel } : {}) });
    await s.input(id, "prompt");
    let jobs = await until(() => s.control<Job[]>("/jobs"), j => j.length === 1);
    assert.equal(jobs[0]!.request.destination.routeKey, "pi-no-compaction-v1");
    assert.equal(llmInput(jobs[0]!).providerOptions.parallel_tool_calls, true);
    assert.deepEqual(llmInput(jobs[0]!).tools.map(t => t.name), ["read", "bash", "edit", "write"]);
    await s.control("/finish", { id: jobs[0]!.id, outcome: response(provider) });
    jobs = await until(() => s.control<Job[]>("/jobs"), j => j.length === 4);
    assert.equal(jobs.some(j => j.request.submission.request.provider === "tool-pi-edit"), false);
    assert.deepEqual(job(jobs, "tool-pi-write").request.submission.request.input, { path: "file", content: "old", machineId: config.machineId, cwd: config.cwd });
    await s.input(id, "steer1"); await s.input(id, "steer2");
    await until(() => s.page(id), p => p.state.pendingMessageCount === 2);
    await s.control("/finish", { id: job(jobs, "tool-pi-write").id, outcome: bashResult });
    jobs = await until(() => s.control<Job[]>("/jobs"), j => j.length === 5);
    await s.control("/finish", { id: job(jobs, "tool-pi-edit").id, outcome: bashResult });
    await s.control("/finish", { id: job(jobs, "tool-pi-bash").id, outcome: bashResult });
    await until(() => s.page(id), p => p.state.activeToolCount === 1);
    assert.equal((await s.control<Job[]>("/jobs")).length, 5);
    const delivered = await s.control("/finish", { id: job(jobs, "tool-pi-read").id, outcome: imageResult });
    assert.equal(delivered.ok, true);
    const duplicate = await s.control("/finish", { id: job(jobs, "tool-pi-read").id, outcome: imageResult });
    assert.equal((duplicate.value as { duplicate: boolean }).duplicate, true);
    jobs = await until(() => s.control<Job[]>("/jobs"), j => j.length === 6);
    const messages = llmInput(jobs[5]!).messages;
    assert.deepEqual(messages.filter(m => m.role === "tool_result").map(m => m.toolName), ["read", "bash", "write", "edit"]);
    assert.deepEqual((messages.find(m => m.role === "tool_result" && m.toolName === "read") as { content: unknown }).content, (imageResult as unknown as { result: { content: unknown } }).result.content);
    assert.deepEqual(messages.slice(-2).map(m => m.role !== "custom" && m.content), [[{ type: "text", text: "steer1" }], [{ type: "text", text: "steer2" }]]);
    await s.control("/finish", { id: jobs[5]!.id, outcome: response(provider, false) });
    await until(() => s.page(id), p => p.state.phase === "idle" && p.state.status === "idle");
    const row = await s.db.prepare("SELECT status FROM sessions WHERE session_id = ?").bind(id).first(); assert.equal(row!.status, "idle");
    assert.equal((await s.request<{ messages: unknown[] }>(`/v1/sessions/${id}/messages?limit=1`)).messages.length, 1);
  } finally { await s.app.dispose(); }
});
test("cold host restart preserves buffered results, queued mutation order, cancellation and held steering", async () => {
  const path = await mkdtemp(join(tmpdir(), "pi-harness-restart-")); let s = await startStack(path);
  try {
    const id = await s.create("restart"); await s.input(id, "prompt");
    let jobs = await until(() => s.control<Job[]>("/jobs"), j => j.length === 1);
    await s.control("/finish", { id: jobs[0]!.id, outcome: response("openai") });
    jobs = await until(() => s.control<Job[]>("/jobs"), j => j.length === 4);
    await s.control("/finish", { id: job(jobs, "tool-pi-bash").id, outcome: bashResult });
    await s.input(id, "held"); const runId = (await s.page(id)).state.runId;
    await s.input(id, "cancel", "pi_no_compaction.cancel", { runId });
    await until(() => s.page(id), p => p.state.status === "cancelling" && p.state.activeToolCount === 2);
    await s.app.dispose(); s = await startStack(path);
    assert.equal((await s.page(id)).state.activeToolCount, 2);
    await s.control("/finish", { id: job(jobs, "tool-pi-write").id, outcome: bashResult });
    jobs = await until(() => s.control<Job[]>("/jobs"), j => j.length === 5);
    await s.control("/finish", { id: job(jobs, "tool-pi-edit").id, outcome: bashResult });
    await s.control("/finish", { id: job(jobs, "tool-pi-read").id, outcome: imageResult });
    await until(() => s.page(id), p => p.state.phase === "cancelled");
    assert.equal((await s.page(id)).state.pendingMessageCount, 1);
    await s.input(id, "resume", "pi_no_compaction.resume", {});
    jobs = await until(() => s.control<Job[]>("/jobs"), j => j.length === 6);
    assert.equal(llmInput(jobs[5]!).messages.at(-1)?.role, "user");
  } finally { await s.app.dispose(); await rm(path, { recursive: true, force: true }); }
});
test("new route validates configuration, isolates sessions and keeps host private", async () => {
  const s = await startStack(); try {
    const id = await s.create("validation"), other = await s.create("other");
    await s.request("/v1/sessions", "POST", { requestId: "bad-model", harness: { id: "pi-no-compaction", version: "v1" },
      config: { ...config, provider: "fireworks", modelId: "accounts/fireworks/models/glm-5p3" }, metadata: {} }, 400);
    assert.equal((await s.app.dispatchFetch(`https://api/v1/sessions/${id}/messages`)).status, 401);
    await s.input(id, "prompt"); await until(() => s.page(id), p => p.state.phase === "llm");
    assert.equal((await s.page(other)).state.phase, "idle");
    const wrong = await s.control("/internal", { sessionId: id, command: { action: "initialize", value: { session: { sessionId: other, harness: { id: "pi-no-compaction", version: "v1" } }, config } } });
    assert.equal(wrong.ok, false);
    const host = await s.app.getWorker("host"); assert.equal((await host.fetch("https://host/session")).status, 404);
    const deploy = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    assert.equal(deploy.workers_dev, false); assert.equal(deploy.preview_urls, false); assert.equal(deploy.services.length, 5);
    assert.equal(deploy.durable_objects.bindings[0].class_name, "PiNoCompactionSessionV1");
  } finally { await s.app.dispose(); }
});
