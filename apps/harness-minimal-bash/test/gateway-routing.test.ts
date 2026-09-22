import assert from "node:assert/strict";
import test from "node:test";
import type { LlmSubmission, ToolExecutionContext } from "@managed-agents/contracts";
import { startStack, until, llmResult, bashResult, config } from "./stack.ts";
import type { Job } from "./stack.ts";

test("session config selects discovery and tool gateways, persists after eviction and fences callbacks by origin", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  const urls = ["https://first.example", "https://second.example"];
  for (const [index, gatewayUrl] of urls.entries()) {
    const key = `gateway-${index}`;
    const id = await s.create(key, { executionGatewayUrl: gatewayUrl.toUpperCase() + "/" });
    const retry = await s.control("/internal", { sessionId: id, command: { action: "initialize",
      value: { session: { sessionId: id, harness: { id: "minimal-bash", version: "v7" } },
        config: { ...config, executionGatewayUrl: "https://replacement.example" } } } });
    assert.equal(retry.ok, true);
    await s.app.unsafeEvictDurableObject("host", "MinimalBashSessionV7", { name: id });
    await s.input(id, "prompt");
    const llm = (await until(() => s.control<Job[]>("/jobs"), jobs => jobs.some(j => j.request.destination.sessionId === id)))
      .find(j => j.request.destination.sessionId === id)!;
    assert.ok(!JSON.stringify(llm.request).includes(gatewayUrl));
    await s.control("/finish", { id: llm.id, outcome: llmResult(["pwd"]) });
    const tool = (await until(() => s.control<Job[]>("/jobs"),
      jobs => jobs.some(j => j.request.destination.sessionId === id && j.request.submission.request.provider === "tool-pi-bash")))
      .find(j => j.request.destination.sessionId === id && j.request.submission.request.provider === "tool-pi-bash")!;
    const request = tool.request as LlmSubmission & { execution: ToolExecutionContext };
    assert.equal(request.execution.gatewayUrl, gatewayUrl);
    assert.equal(request.execution.token, config.executionToken);
    assert.ok(!JSON.stringify(request.submission).includes(gatewayUrl));
    await s.app.unsafeEvictDurableObject("host", "MinimalBashSessionV7", { name: id });
    const completion = { operationId: request.submission.operationId, submissionId: request.submission.submissionId,
      provider: "tool-pi-bash", jobId: tool.id, outcome: bashResult };
    for (const wrong of [undefined, urls[1 - index]]) {
      const rejected = await s.control("/internal", { sessionId: id, command: { action: "acceptToolCompletion",
        value: { completion, execution: { gatewayUrl: wrong, machineId: config.machineId, runtimeGeneration: request.execution.runtimeGeneration } } } });
      assert.equal(rejected.ok, false);
      assert.match(JSON.stringify(rejected), /COMPLETION_CONFLICT/);
    }
    assert.equal((await s.control("/finish", { id: tool.id, outcome: bashResult })).ok, true);
  }
  const discoveries = await s.control<{ url: string; authorization: string }[]>("/discoveries");
  assert.deepEqual(discoveries, urls.map(url => ({ url: `${url}/v1/machines/${config.machineId}`, authorization: `Bearer ${config.executionToken}` })));
});

test("creation requires a valid gateway URL inside harness config", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  for (const [index, executionGatewayUrl] of [undefined, null, "http://gateway.example", "https://gateway.example/path"].entries()) {
    const reply = await s.request("/v1/sessions", "POST", { requestId: `invalid-gateway-${index}`,
      harness: { id: "minimal-bash", version: "v7" }, config: { ...config, executionGatewayUrl }, metadata: {} }, 400);
    assert.match(JSON.stringify(reply), /INVALID_CONFIG/);
  }
});
