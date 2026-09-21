import { executionFor } from "../../../packages/session-execution/test/fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { Log, LogLevel, Miniflare } from "miniflare";
import type { Request as WorkerRequest } from "miniflare";
import { FakeGateway as LlmGateway, event as llmEvent, signed as signLlm } from "../../llm-gateway-workers/test/stack.ts";
import { FakeGateway as BashGateway, event as bashEvent } from "../../tools/tool-pi-bash-workers/test/stack.ts";
import { FakeGateway as ReadGateway, FakeImages, imageAccountId, fileResult, png, event as readEvent } from "../../tools/tool-pi-read-workers/test/stack.ts";
import { FakeGateway as WriteGateway, event as writeEvent, machineId as writeMachineId } from "../../tools/tool-pi-write-workers/test/stack.ts";
import { FakeGateway as EditGateway, event as editEvent } from "../../tools/tool-pi-edit-workers/test/stack.ts";
import { bundle, config, token, until } from "./stack.ts";
import type { Page } from "./stack.ts";
import type { LlmInput, LlmResponse } from "@managed-agents/contracts";

for (const provider of ["openai", "fireworks"] as const) test(`${provider}: production host runtime discovery and configured machine secret validates new callbacks for all four Pi tools`, async () => {
  const names = ["bash", "read", "edit", "write"] as const;
  const [api, host, llm, ...scripts] = await Promise.all([
    bundle("../../agent-api/src/index.ts"), bundle("../src/index.ts"), bundle("../../llm-gateway-workers/src/index.ts"),
    ...names.map(n => bundle(`../../tools/tool-pi-${n}-workers/src/index.ts`)),
  ]);
  const callbacks = await bundle("./callbacks.ts");
  const llmGateway = new LlmGateway(), bashGateway = new BashGateway(), readGateway = new ReadGateway(),
    writeGateway = new WriteGateway(), editGateway = new EditGateway(), images = new FakeImages();
  const gateways = { bash: bashGateway, read: readGateway, write: writeGateway, edit: editGateway };
  const common = { modules: true, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"] };
  const namespaces = { PI_NO_COMPACTION_SESSIONS: { className: "PiNoCompactionSessionV1", scriptName: "host" } };
  const routes = JSON.stringify({ "pi-no-compaction-v1": "PI_NO_COMPACTION_SESSIONS" });
  const denyNetwork = () => { throw new Error("Unexpected external request."); };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "api", script: api, bindings: { BACKEND_TOKEN: token }, d1Databases: { SESSION_DIRECTORY: "directory" }, durableObjects: namespaces, outboundService: denyNetwork },
    { ...common, name: "host", script: host, d1Databases: { SESSION_DIRECTORY: "directory" },
      durableObjects: { PI_NO_COMPACTION_SESSIONS: { className: "PiNoCompactionSessionV1", useSQLite: true } },
      serviceBindings: { LLM: { name: "llm", entrypoint: "LlmGateway" },
        ...Object.fromEntries(names.map(n => [n.toUpperCase(), { name: n, entrypoint: `Pi${n[0]!.toUpperCase()}${n.slice(1)}` }])) }, bindings: { EXECUTION_GATEWAY_URL: "https://gateway.test" }, outboundService: { name: "callbacks" } },
    { ...common, name: "callbacks", script: callbacks, durableObjects: namespaces,
      serviceBindings: Object.fromEntries(names.map(n => [n.toUpperCase(), { name: n, entrypoint: `Pi${n[0]!.toUpperCase()}${n.slice(1)}Callbacks` }])), outboundService: denyNetwork },
    { ...common, name: "llm", script: llm, durableObjects: namespaces,
      bindings: { GATEWAY_URL: "https://gateway.test", GATEWAY_API_KEY: "test-key", GATEWAY_WEBHOOK_SECRET: "test-webhook-secret", SESSION_ROUTES: routes },
      outboundService: (request: WorkerRequest) => llmGateway.fetch(request) },
    ...names.map((name, i) => ({ ...common, name, script: scripts[i]!, durableObjects: namespaces,
      bindings: { EXECUTION_GATEWAY_URL: "https://gateway.test", SESSION_ROUTES: routes,
        CLOUDFLARE_IMAGES_ACCOUNT_ID: imageAccountId, CLOUDFLARE_IMAGES_API_TOKEN: "images-key", CLOUDFLARE_IMAGES_VARIANT: "piread" },
      outboundService: (request: WorkerRequest) => new URL(request.url).hostname === "api.cloudflare.com" ? images.fetch(request) : gateways[name].fetch(request) })),
  ] });
  try {
    const db = await app.getD1Database("SESSION_DIRECTORY", "api");
    const sql = await readFile(new URL("../../agent-api/migrations/0001_initial.sql", import.meta.url), "utf8");
    for (const statement of sql.split(";").filter(s => s.trim())) await db.prepare(statement).run();
    async function request(path: string, body?: unknown) {
      const res = await app.dispatchFetch(`https://api${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.ok(res.ok, await res.clone().text()); return res;
    }
    const modelId = provider === "openai" ? config.modelId : "accounts/fireworks/models/glm-5p3-flash";
    const created = await (await request("/v1/sessions", { requestId: "real-workers", harness: { id: "pi-no-compaction", version: "v1" }, config: { ...config, provider, modelId, machineId: writeMachineId, executionToken: executionFor(writeMachineId).token }, metadata: {} })).json() as { session: { identity: { sessionId: string } } };
    const id = created.session.identity.sessionId;
    const page = async () => (await request(`/v1/sessions/${id}/messages`)).json() as Promise<Page>;
    await request(`/v1/sessions/${id}/inputs`, { eventId: "prompt", event: { type: "pi_no_compaction.message", payload: { message: { role: "user", content: [{ type: "text", text: "Inspect and edit" }] } } } });
    await until(async () => llmGateway.jobs.size, size => size === 1);
    const first = [...llmGateway.jobs.values()][0]!;
    const calls = [
      { id: "r", name: "read", arguments: JSON.stringify({ path: "image.png" }) },
      { id: "b", name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
      { id: "w", name: "write", arguments: JSON.stringify({ path: "file", content: "old" }) },
      { id: "e", name: "edit", arguments: JSON.stringify({ path: "file", edits: [{ oldText: "old", newText: "new" }] }) },
    ];
    const native: LlmResponse = { id: "response", modelId, durationMs: 1, timestamp: 1, stopReason: "tool_use", message: { role: "assistant", provider,
      content: provider === "openai" ? [{ type: "reasoning", encrypted_content: "opaque", summary: [] },
        ...calls.map(c => ({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments }))]
        : [{ role: "assistant", reasoning_content: "opaque", content: null, tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }] } };
    llmGateway.finish(first, "succeeded", native);
    const llmWorker = await app.getWorker("llm");
    assert.equal((await llmWorker.fetch("https://llm/webhooks/llm-gateway", signLlm(llmEvent(first)))).status, 204);
    await until(async () => [bashGateway.jobs.size, readGateway.jobs.size, writeGateway.jobs.size], sizes => sizes.every(n => n === 1));
    assert.equal(editGateway.jobs.size, 0);
    async function deliverNew(name: string, event: unknown) {
      const reply = await (await app.getWorker("callbacks")).fetch(`https://test/${name}`, { method: "POST", body: JSON.stringify(event) });
      assert.equal(reply.status, 200, await reply.text());
    }
    const w = [...writeGateway.jobs.values()][0]!; writeGateway.finish(w); await deliverNew("write", await writeEvent(w));
    await until(async () => editGateway.jobs.size, size => size === 1);
    const e = [...editGateway.jobs.values()][0]!; editGateway.finish(e); await deliverNew("edit", await editEvent(e));
    const b = [...bashGateway.jobs.values()][0]!; bashGateway.finish(b); await deliverNew("bash", await bashEvent(b));
    await until(page, p => p.state.activeToolCount === 1);
    assert.equal(llmGateway.jobs.size, 1);
    const r = [...readGateway.jobs.values()][0]!;
    readGateway.finish(r, fileResult(png));
    const readCallback = await readEvent(r); await deliverNew("read", readCallback); await deliverNew("read", readCallback);
    await until(async () => llmGateway.jobs.size, size => size === 2);
    assert.equal(images.posts, 1); assert.deepEqual(images.uploadBytes, png);
    const next = [...llmGateway.jobs.values()][1]!, input = next.request as Exclude<LlmInput, { previousJobId: string }>;
    const results = input.messages.filter(m => m.role === "tool_result");
    assert.deepEqual(results.map(m => m.toolName), ["read", "bash", "write", "edit"]);
    assert.ok(results.every(m => m.outcome.status === "success"));
    assert.ok(results[0]!.content.some(p => p.type === "image" && p.url.endsWith("/piread")));
    assert.deepEqual(input.messages.find(m => m.role === "assistant"), native.message);
    llmGateway.finish(next, "succeeded", { ...native, stopReason: "stop", message: { role: "assistant", provider, content: provider === "openai"
      ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] : [{ role: "assistant", content: "done" }] } });
    assert.equal((await llmWorker.fetch("https://llm/webhooks/llm-gateway", signLlm(llmEvent(next)))).status, 204);
    await until(page, p => p.state.phase === "idle");
    assert.equal(llmGateway.details, 0);
    for (const gateway of Object.values(gateways)) { assert.equal(gateway.posts, 1); assert.equal(gateway.details, 0); }
  } finally { await app.dispose(); }
});
