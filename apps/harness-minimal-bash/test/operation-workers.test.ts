import { executionFor } from "../../../packages/session-execution/test/fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { Log, LogLevel, Miniflare } from "miniflare";
import type { Request as WorkerRequest } from "miniflare";
import { FakeGateway as LlmGateway, event as llmEvent, signed as signLlm } from "../../llm-gateway-workers/test/stack.ts";
import { FakeGateway as ExecutionGateway, event as bashEvent, machineId as bashMachineId } from "../../tools/tool-pi-bash-workers/test/stack.ts";
import { bundle, config, llmResult, token, until } from "./stack.ts";
import type { Page } from "./stack.ts";
import type { JsonValue, LlmInput, LlmResponse } from "@managed-agents/contracts";

for (const oversized of [false, true]) test(oversized
  ? "oversized gateway results fail the harness and finish delivery without retrying or executing tools"
  : "real workers replay a large inline native response through LLM/bash/LLM without chunk tables", async () => {
  const [api, host, llm, bash, bridge] = await Promise.all([
    bundle("../../agent-api/src/index.ts"), bundle("../src/index.ts"), bundle("../../llm-gateway-workers/src/index.ts"),
    bundle("../../tools/tool-pi-bash-workers/src/index.ts"), bundle("./callbacks.ts"),
  ]);
  const llmGateway = new LlmGateway(), executionGateway = new ExecutionGateway();
  const common = { modules: true, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"] };
  const namespaces = { MINIMAL_BASH_SESSIONS: { className: "MinimalBashSessionV7", scriptName: "host" } };
  const routes = JSON.stringify({ "minimal-bash-v7": "MINIMAL_BASH_SESSIONS" });
  const denyNetwork = () => { throw new Error("Unexpected external request."); };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "api", script: api, bindings: { BACKEND_TOKEN: token }, d1Databases: { SESSION_DIRECTORY: "directory" }, durableObjects: namespaces, outboundService: denyNetwork },
    { ...common, name: "host", script: host, d1Databases: { SESSION_DIRECTORY: "directory" },
      durableObjects: { MINIMAL_BASH_SESSIONS: { className: "MinimalBashSessionV7", useSQLite: true } },
      serviceBindings: { LLM: { name: "llm", entrypoint: "LlmGateway" }, BASH: { name: "bash", entrypoint: "PiBash" } }, bindings: { }, outboundService: { name: "bridge" } },
    { ...common, name: "llm", script: llm, durableObjects: namespaces,
      bindings: { GATEWAY_URL: "https://gateway.test", GATEWAY_API_KEY: "test-key", GATEWAY_WEBHOOK_SECRET: "test-webhook-secret", SESSION_ROUTES: routes },
      outboundService: (request: WorkerRequest) => llmGateway.fetch(request) },
    { ...common, name: "bash", script: bash, durableObjects: namespaces,
      bindings: { SESSION_ROUTES: routes },
      outboundService: (request: WorkerRequest) => executionGateway.fetch(request) },
    // Callback-only test receiver. Production tool submissions use the real host adapter.
    { ...common, name: "bridge", script: bridge, durableObjects: namespaces, serviceBindings: {
      BASH: {name: "bash", entrypoint: "PiBash"}, EVENT: {name: "bash", entrypoint: "PiBashCallbacks"},
    }, outboundService: denyNetwork },
  ] });
  try {
    for (const [worker, binding, files] of [
      ["api", "SESSION_DIRECTORY", ["../../agent-api/migrations/0001_initial.sql"]],
    ] as const) {
      const db = await app.getD1Database(binding, worker);
      for (const file of files) {
        const sql = await readFile(new URL(file, import.meta.url), "utf8");
        for (const statement of sql.split(";").filter(s => s.trim())) await db.prepare(statement).run();
      }
    }
    async function request(path: string, body?: unknown) {
      const res = await app.dispatchFetch(`https://api${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.ok(res.ok, await res.clone().text()); return res;
    }
    const created = await (await request("/v1/sessions", { requestId: "real-workers", harness: { id: "minimal-bash", version: "v7" }, config: {...config, machineId: bashMachineId, executionToken: executionFor(bashMachineId).token}, metadata: {} })).json() as { session: { identity: { sessionId: string } } };
    const id = created.session.identity.sessionId;
    await request(`/v1/sessions/${id}/inputs`, { eventId: "prompt", event: { type: "minimal_bash.message", payload: { message: { role: "user", content: [{ type: "text", text: "Check this repository" }] } } } });
    await until(async () => llmGateway.jobs.size, size => size === 1);
    const first = [...llmGateway.jobs.values()][0]!;
    const firstInput = first.request as Exclude<LlmInput, { previousJobId: string }>;
    assert.match(firstInput.instructions!, /\/workspace/);
    assert.deepEqual(firstInput.messages.map(message => message.role), ["user"]);
    const firstResult = llmResult(["printf 'ok'"]);
    assert.equal(firstResult.status, "succeeded");
    const native = (firstResult as unknown as { result: { response: LlmResponse } }).result.response;
    const reasoning = { type: "reasoning", id: "large-native", encrypted_content: "x".repeat(oversized ? 2_000_000 : 1_800_000), summary: [] };
    native.message.content.unshift(reasoning);
    llmGateway.finish(first, "succeeded", ((firstResult as unknown as { result: { response: JsonValue } }).result.response));
    const llmWorker = await app.getWorker("llm"), callbackWorker = await app.getWorker("bridge");
    assert.equal((await llmWorker.fetch("https://llm/webhooks/llm-gateway", signLlm(llmEvent(first)))).status, 204);
    if (oversized) {
      const failed = await until(async () => (await request(`/v1/sessions/${id}/messages`)).json() as Promise<Page>, page => page.state.status === "failed");
      assert.equal(failed.state.phase, "failed"); assert.equal(failed.state.activeOperationId, null);
      assert.equal(failed.state.processingBlocked, false);
      assert.match(JSON.stringify(failed.state.error), /exceeds.*inline/);
      assert.deepEqual(failed.messages.map(row => row.message.role), ["user"]);
      assert.equal(executionGateway.jobs.size, 0); assert.equal(llmGateway.jobs.size, 1);
      assert.equal((await llmWorker.fetch("https://llm/webhooks/llm-gateway", signLlm(llmEvent(first)))).status, 204);
      assert.equal(llmGateway.jobs.size, 1); assert.equal(executionGateway.jobs.size, 0);
      assert.equal(llmGateway.details, 0, "inline size failure needs no result fetch");
      return;
    }
    await until(async () => executionGateway.jobs.size, size => size === 1);
    const command = [...executionGateway.jobs.values()][0]!;
    assert.equal((command.body.callback.context as any).machineId, bashMachineId); assert.equal((command.body.operation.params as any).cwd, config.cwd);
    assert.equal(command.body.callback.receiver, "tool-pi-bash-v1");
    executionGateway.finish(command);
    const event = await bashEvent(command);
    assert.equal((await callbackWorker.fetch("https://test/event", {method: "POST", body: JSON.stringify(event)})).status, 200);
    assert.equal((await callbackWorker.fetch("https://test/event", {method: "POST", body: JSON.stringify(event)})).status, 200);
    await until(async () => llmGateway.jobs.size, size => size === 2);
    const last = [...llmGateway.jobs.values()][1]!;
    const input = last.request as Exclude<LlmInput, { previousJobId: string }>;
    assert.equal(input.previousJobId, null); assert.equal(input.messages.at(-1)?.role, "tool_result");
    assert.equal(input.instructions, firstInput.instructions);
    assert.equal(input.messages.some(message => message.role === "system"), false);
    assert.ok(input.messages.every(m => m.role !== "custom"));
    assert.deepEqual(input.messages.find(m => m.role === "assistant")?.content[0], reasoning);
    assert.ok(JSON.stringify(input).length > 1_800_000);
    const lastResult = llmResult();
    llmGateway.finish(last, "succeeded", ((lastResult as unknown as { result: { response: JsonValue } }).result.response));
    assert.equal((await llmWorker.fetch("https://llm/webhooks/llm-gateway", signLlm(llmEvent(last)))).status, 204);
    const page = await until(async () => (await request(`/v1/sessions/${id}/messages`)).json() as Promise<Page>, page => page.state.status === "idle");
    const messages = [...page.messages];
    let next = page.nextCursor;
    while (next !== null) {
      const following = await (await request(`/v1/sessions/${id}/messages?after=${next}`)).json() as Page;
      messages.push(...following.messages); next = following.nextCursor;
    }
    assert.equal(messages.filter(row => row.message.role === "assistant").length, 2);
    assert.deepEqual(messages.find(row => row.message.role === "assistant")?.message.content?.[0], reasoning);
    assert.equal(messages.filter(row => row.message.role === "tool_result").length, 1);
    assert.equal(executionGateway.jobs.size, 1);
    assert.equal(executionGateway.details, 0);
    assert.equal(llmGateway.details, 0, "the full LLM/bash/LLM callback flow makes no LLM result GETs");
  } finally { await app.dispose(); }
});
