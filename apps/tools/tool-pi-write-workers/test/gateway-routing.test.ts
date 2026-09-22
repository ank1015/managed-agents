import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Response as MFResponse } from "miniflare";
import { issueMachineSecret } from "@managed-agents/execution-gateway-protocol";
import type { ProviderSubmitResult } from "@managed-agents/contracts";
import { FakeGateway, startStack, input, execution, event, until, auth, machineId } from "./stack.ts";

async function submission() {
  return { destination: { routeKey: "test-v1", sessionId: "routing" }, execution: await execution("routing"),
    submission: { operationId: "routing", submissionId: "routing",
      request: { provider: "tool-pi-write", type: "write", version: "v1", input } } };
}

test("one tool Worker routes independent sessions to their configured gateways and returns private callbacks", async t => {
  const gateways = [new FakeGateway("https://first.example"), new FakeGateway("https://second.example")];
  const router = new FakeGateway();
  router.fetch = request => {
    const gateway = gateways.find(g => g.origin === new URL(request.url).origin);
    assert.ok(gateway, "Unexpected gateway request");
    return gateway.fetch(request);
  };
  const s = await startStack(router); t.after(() => s.app.dispose());
  await Promise.all(gateways.map(async (gateway, index) => {
    const sessionId = randomUUID();
    const context = { ...await execution(sessionId), gatewayUrl: gateway.origin,
      token: await issueMachineSecret(auth, machineId, "execution", index + 1) };
    await s.call("/start", { sessionId, input, execution: context });
    const job = await until(async () => [...gateway.jobs.values()].find(j => j.destination.sessionId === sessionId));
    assert.equal(gateway.requests[0]!.url, `${gateway.origin}/v1/machines/${machineId}/requests`);
    assert.equal(gateway.requests[0]!.authorization, `Bearer ${context.token}`);
    assert.equal((job.body.callback.context as { gatewayUrl: string }).gatewayUrl, gateway.origin);
    assert.ok(!JSON.stringify(job.body).includes(context.token));
    gateway.finish(job);
    await s.call("/event", await event(job));
    const snapshot = await until(async () => { const row = await s.call("/snapshot", { sessionId }); return row.results.length ? row : undefined; });
    assert.equal(snapshot.operations[0]!.outcome!.status, "succeeded");
    assert.equal(snapshot.admittedCompletions, 1);
    assert.equal(gateway.jobs.size, 1);
  }));
});

test("missing or invalid gateway URLs reject before any network dispatch", async t => {
  const s = await startStack(); t.after(() => s.app.dispose());
  const value = await submission();
  for (const gatewayUrl of [undefined, null, "http://insecure.example", "https://user:secret@host.example", "https://host.example/path", "https://host.example?token=secret"]) {
    const result = await s.call<ProviderSubmitResult>("/submit", { ...value, execution: { ...value.execution, gatewayUrl } });
    assert.equal(result.status, "rejected");
  }
  assert.equal(s.gateway.requests.length, 0);
});

test("gateway redirects are not followed with machine credentials", async t => {
  const gateway = new FakeGateway();
  const requests: string[] = [];
  gateway.fetch = async request => {
    requests.push(request.url);
    return new MFResponse(null, { status: 307, headers: { Location: "https://untrusted.example/steal" } });
  };
  const s = await startStack(gateway); t.after(() => s.app.dispose());
  await assert.rejects(s.call("/submit", await submission()));
  assert.deepEqual(requests, [`https://gateway.test/v1/machines/${machineId}/requests`]);
});
