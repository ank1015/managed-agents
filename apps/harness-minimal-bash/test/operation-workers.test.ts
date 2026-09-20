import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { Log, LogLevel, Miniflare } from "miniflare";
import type { Request as WorkerRequest } from "miniflare";
import { FakeGateway as LlmGateway, event as llmEvent, signed as signLlm } from "../../llm-gateway-workers/test/stack.ts";
import { FakeGateway as ExecutionGateway, event as bashEvent, signed as signBash } from "../../tool-pi-bash-workers/test/stack.ts";
import { bundle, config, llmResult, token, until } from "./stack.ts";
import type { Page } from "./stack.ts";
import type { JsonValue, LlmInput, LlmResponse } from "@managed-agents/contracts";

for (const oversized of [false, true]) test(oversized
  ? "oversized gateway results fail the harness and finish delivery without retrying or executing tools"
  : "real workers replay a large inline native response through LLM/bash/LLM without chunk tables", async () => {
  const [api, host, llm, bash, callbacks] = await Promise.all([
    bundle("../../agent-api/src/index.ts"), bundle("../src/index.ts"), bundle("../../llm-gateway-workers/src/index.ts"),
    bundle("../../tool-pi-bash-workers/src/index.ts"), bundle("../../execution-gateway-callback-workers/src/index.ts"),
  ]);
  const llmGateway = new LlmGateway(), executionGateway = new ExecutionGateway();
  const common = { modules: true, compatibilityDate: "2026-07-30" };
  const namespaces = { MINIMAL_BASH_SESSIONS: { className: "MinimalBashSessionV7", scriptName: "host" } };
  const routes = JSON.stringify({ "minimal-bash-v7": "MINIMAL_BASH_SESSIONS" });
  const denyNetwork = () => { throw new Error("Unexpected external request."); };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "api", script: api, bindings: { BACKEND_TOKEN: token }, d1Databases: { SESSION_DIRECTORY: "directory" }, durableObjects: namespaces, outboundService: denyNetwork },
    { ...common, name: "host", script: host, d1Databases: { SESSION_DIRECTORY: "directory" },
      durableObjects: { MINIMAL_BASH_SESSIONS: { className: "MinimalBashSessionV7", useSQLite: true } },
      serviceBindings: { LLM: { name: "llm", entrypoint: "LlmGateway" }, BASH: { name: "bash", entrypoint: "PiBash" } }, outboundService: denyNetwork },
    { ...common, name: "llm", script: llm, durableObjects: namespaces,
      bindings: { GATEWAY_URL: "https://gateway.test", GATEWAY_API_KEY: "test-key", GATEWAY_WEBHOOK_SECRET: "test-webhook-secret", SESSION_ROUTES: routes },
      outboundService: (request: WorkerRequest) => llmGateway.fetch(request) },
    { ...common, name: "bash", script: bash, durableObjects: namespaces,
      bindings: { EXECUTION_GATEWAY_URL: "https://gateway.test", EXECUTION_GATEWAY_API_KEY: "test-key", SESSION_ROUTES: routes },
      outboundService: (request: WorkerRequest) => executionGateway.fetch(request) },
    { ...common, name: "callbacks", script: callbacks,
      bindings: { EXECUTION_GATEWAY_WEBHOOK_SECRET: "test-webhook-secret", CALLBACK_ROUTES: JSON.stringify({ "tool-pi-bash-v1": "BASH_EVENTS" }) },
      serviceBindings: { BASH_EVENTS: { name: "bash", entrypoint: "PiBashCallbacks" } },
      outboundService: denyNetwork },
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
    const created = await (await request("/v1/sessions", { requestId: "real-workers", harness: { id: "minimal-bash", version: "v7" }, config, metadata: {} })).json() as { session: { identity: { sessionId: string } } };
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
    const llmWorker = await app.getWorker("llm"), callbackWorker = await app.getWorker("callbacks");
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
    assert.equal(command.machineId, config.machineId); assert.equal(command.request.params.cwd, config.cwd);
    assert.equal(command.clientContext.receiver, "tool-pi-bash-v1");
    executionGateway.finish(command);
    const event = bashEvent(command);
    assert.equal((await callbackWorker.fetch("https://callbacks/webhooks/execution-gateway", signBash(event))).status, 204);
    assert.equal((await callbackWorker.fetch("https://callbacks/webhooks/execution-gateway", signBash(event))).status, 204);
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
    assert.equal(executionGateway.details, 0); assert.equal(executionGateway.lookups, 0);
    assert.equal(llmGateway.details, 0, "the full LLM/bash/LLM callback flow makes no LLM result GETs");
  } finally { await app.dispose(); }
});
