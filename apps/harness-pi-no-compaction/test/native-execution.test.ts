import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";
import type { Request as WorkerRequest } from "miniflare";
import { FakeGateway, event, signed } from "../../llm-gateway-workers/test/stack.ts";
import { FakeImages, imageAccountId, png } from "../../tools/tool-pi-read-workers/test/stack.ts";
import { bundle, config, until } from "./stack.ts";
import type { LlmInput, LlmResponse } from "@managed-agents/contracts";

test("agent-api and both production hosts run native tools through machine-secret gateway, Machine DO and real daemon", { timeout: 120000 }, async t => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  await promisify(execFile)("cargo", ["build", "--manifest-path", join(root, "execution/Cargo.toml"), "-p", "process-execution-daemon"], { maxBuffer: 2_000_000 });
  const dir = await mkdtemp(join(tmpdir(), "harness-execution-")), state = join(dir, "state");
  await writeFile(join(dir, "image.png"), png);
  const names = ["bash", "read", "write", "edit"] as const;
  const [api, gateway, minimal, pi, llm, ...tools] = await Promise.all([
    bundle("../../agent-api/src/index.ts"), bundle("../../../execution/apps/execution-gateway/src/index.ts"),
    bundle("../../harness-minimal-bash/src/index.ts"), bundle("../src/index.ts"), bundle("../../llm-gateway-workers/src/index.ts"),
    ...names.map(n => bundle(`../../tools/tool-pi-${n}-workers/src/index.ts`)),
  ]);
  const backend = "native-harness-test-backend-secret-32-bytes", auth = "native-harness-auth-secret-at-least-32-bytes";
  const common = { modules: true, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"] };
  const ns = { MINIMAL_BASH_SESSIONS: { className: "MinimalBashSessionV7", scriptName: "minimal" }, PI_NO_COMPACTION_SESSIONS: { className: "PiNoCompactionSessionV1", scriptName: "pi" } };
  const routes = JSON.stringify({ "minimal-bash-v7": "MINIMAL_BASH_SESSIONS", "pi-no-compaction-v1": "PI_NO_COMPACTION_SESSIONS" });
  const d1Databases = { SESSION_DIRECTORY: "native-directory" }, llmGateway = new FakeGateway(), images = new FakeImages();
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: "gateway", script: gateway, bindings: { MANAGEMENT_SECRET: backend, CREDENTIAL_SIGNING_SECRET: auth, ROUTING_SIGNING_SECRET: auth + "routing", CALLBACK_TIMEOUT_MS: "30000",
      CALLBACK_ROUTES: JSON.stringify({ ...Object.fromEntries(names.map(n => [`tool-pi-${n}-v1`, n.toUpperCase()])) }) },
      durableObjects: { MACHINES: { className: "Machine", useSQLite: true } }, serviceBindings: {
        ...Object.fromEntries(names.map(n => [n.toUpperCase(), { name: n, entrypoint: `Pi${n[0]!.toUpperCase()}${n.slice(1)}Callbacks` }])),
      } },
    { ...common, name: "api", script: api, bindings: { BACKEND_TOKEN: backend }, d1Databases, durableObjects: ns },
    ...(["minimal", "pi"] as const).map(name => ({ ...common, name, script: name === "pi" ? pi : minimal, d1Databases,
      bindings: { EXECUTION_GATEWAY_URL: "https://gateway.test" }, outboundService: { name: "gateway" },
      durableObjects: name === "pi" ? { PI_NO_COMPACTION_SESSIONS: { className: "PiNoCompactionSessionV1", useSQLite: true } } : { MINIMAL_BASH_SESSIONS: { className: "MinimalBashSessionV7", useSQLite: true } },
      serviceBindings: { LLM: { name: "llm", entrypoint: "LlmGateway" }, ...Object.fromEntries(names.map(n => [n.toUpperCase(), { name: n, entrypoint: `Pi${n[0]!.toUpperCase()}${n.slice(1)}` }])) } })),
    { ...common, name: "llm", script: llm, durableObjects: ns,
      bindings: { GATEWAY_URL: "https://gateway.test", GATEWAY_API_KEY: "test-key", GATEWAY_WEBHOOK_SECRET: "test-webhook-secret", SESSION_ROUTES: routes },
      outboundService: (request: WorkerRequest) => llmGateway.fetch(request) },
    ...names.map((name, i) => ({ ...common, name, script: tools[i]!, durableObjects: ns,
      bindings: { EXECUTION_GATEWAY_URL: "https://gateway.test", SESSION_ROUTES: routes, CLOUDFLARE_IMAGES_ACCOUNT_ID: imageAccountId, CLOUDFLARE_IMAGES_API_TOKEN: "images-key", CLOUDFLARE_IMAGES_VARIANT: "piread" },
      outboundService: async (request: WorkerRequest) => new URL(request.url).hostname === "api.cloudflare.com" ? images.fetch(request) : (await app.getWorker("gateway")).fetch(request) })),
  ] });
  let daemon: ReturnType<typeof spawn> | undefined, logs = "";
  t.after(async () => {
    if (daemon && daemon.exitCode === null) { const done = new Promise(r => daemon!.once("exit", r)); daemon.kill("SIGTERM"); await done; }
    await app.dispose(); await rm(dir, { recursive: true, force: true });
  });
  const binary = join(root, "execution/target/debug/process-execution-daemon"), address = (await app.ready).origin;
  const registration = spawn(binary, ["--state-dir", state, "register", "--gateway-url", address, "--name", "Harness test", "--allow-insecure-loopback"], { stdio: ["pipe", "pipe", "pipe"] });
  registration.stdin.end(backend + "\n"); registration.stderr.on("data", b => logs += b);
  assert.equal(await new Promise(r => registration.once("exit", r)), 0, logs);
  const machineId = JSON.parse(await readFile(join(state, "credential.json"), "utf8")).machine_id;
  let executionSecret = JSON.parse(await readFile(join(state, "execution-secret.json"), "utf8")).executionSecret;
  let executionVersion = 1;
  daemon = spawn(binary, ["--state-dir", state, "run"], { stdio: ["ignore", "ignore", "pipe"] }); daemon.stderr!.on("data", b => logs += b);
  const db = await app.getD1Database("SESSION_DIRECTORY", "api");
  for (const sql of (await readFile(join(root, "apps/agent-api/migrations/0001_initial.sql"), "utf8")).split(";").filter(s => s.trim())) await db.prepare(sql).run();
  const gatewayApi = await app.getWorker("gateway"), agentApi = await app.getWorker("api"), llmWorker = await app.getWorker("llm");
  async function request(worker: typeof agentApi, path: string, method = "GET", body?: unknown, token = backend) {
    const response = await worker.fetch("https://test" + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, await response.clone().text()); return response.json() as Promise<any>;
  }
  await until(() => request(gatewayApi, `/v1/machines/${machineId}`, "GET", undefined, executionSecret), r => r.machine.connectionStatus === "ready");
  for (const [harness, version, provider] of [["minimal-bash", "v7", "openai"], ["pi-no-compaction", "v1", "openai"], ["pi-no-compaction", "v1", "fireworks"]] as const) {
    const credential = { token: executionSecret };
    const modelId = provider === "openai" ? config.modelId : "accounts/fireworks/models/glm-5p3-flash";
    const created = await request(agentApi, "/v1/sessions", "POST", { requestId: `${harness}-${provider}`, harness: { id: harness, version },
      config: { ...config, machineId, executionToken: credential.token, cwd: dir, provider, modelId }, metadata: {} });
    const id = created.session.identity.sessionId, before = llmGateway.jobs.size;
    await request(agentApi, `/v1/sessions/${id}/inputs`, "POST", { eventId: "prompt", event: { type: `${harness.replaceAll("-", "_")}.message`, payload: { message: { role: "user", content: [{ type: "text", text: "Test tools" }] } } } });
    const nextJob = async (size: number) => { await until(async () => llmGateway.jobs.size, n => n === size); return [...llmGateway.jobs.values()].at(-1)!; };
    type Call = { name: string; arguments: Record<string, unknown> };
    const finish = async (job: Awaited<ReturnType<typeof nextJob>>, calls: Call[]) => {
      const native: LlmResponse = { id: "response", modelId, durationMs: 1, timestamp: 1, stopReason: calls.length ? "tool_use" : "stop", message: { role: "assistant", provider,
        content: provider === "openai" ? (calls.length ? calls.map((c, i) => ({ type: "function_call", call_id: `call-${i}`, name: c.name, arguments: JSON.stringify(c.arguments) })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }])
          : [{ role: "assistant", content: calls.length ? null : "done", ...(calls.length ? { tool_calls: calls.map((c, i) => ({ id: `call-${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) }] } };
      llmGateway.finish(job, "succeeded", native);
      assert.equal((await llmWorker.fetch("https://llm/webhooks/llm-gateway", signed(event(job)))).status, 204);
    };
    const first = await nextJob(before + 1);
    await finish(first, harness === "minimal-bash" ? [{ name: "bash", arguments: { command: "printf bash-ok" } }] : [
      { name: "read", arguments: { path: "image.png" } }, { name: "bash", arguments: { command: "printf bash-ok" } },
      { name: "write", arguments: { path: `${provider}.txt`, content: "old" } }, { name: "edit", arguments: { path: `${provider}.txt`, edits: [{ oldText: "old", newText: "new" }] } },
    ]);
    const second = await nextJob(before + 2), secondInput = second.request as Exclude<LlmInput, { previousJobId: string }>;
    const results = secondInput.messages.filter(m => m.role === "tool_result");
    assert.equal(results.length, harness === "minimal-bash" ? 1 : 4, logs);
    assert.ok(results.every(r => r.outcome.status === "success"), JSON.stringify(results));
    assert.ok(!JSON.stringify(secondInput).includes(credential.token));
    await app.unsafeEvictDurableObject(harness === "minimal-bash" ? "minimal" : "pi", harness === "minimal-bash" ? "MinimalBashSessionV7" : "PiNoCompactionSessionV1", { name: id });
    if (harness !== "minimal-bash") {
      assert.equal(await readFile(join(dir, `${provider}.txt`), "utf8"), "new");
      assert.ok(results[0]!.content.some(p => p.type === "image"));
    }
    await finish(second, harness === "minimal-bash" ? [{ name: "bash", arguments: { command: "printf rotated-key" } }] : [{ name: "read", arguments: { path: `${provider}.txt` } }]);
    const final = await nextJob(before + 3);
    assert.ok(JSON.stringify(final.request).includes(harness === "minimal-bash" ? "rotated-key" : "new"));
    await finish(final, []);
    const page = await until(() => request(agentApi, `/v1/sessions/${id}/messages`), page => page.state.phase === "idle");
    assert.ok(!JSON.stringify(page).includes(credential.token));
    // Existing configuration cannot be patched. The next session receives the new secret.
    const rotation = await request(gatewayApi, `/v1/machines/${machineId}/secrets/rotate`, "POST", { kind: "execution", expectedVersion: executionVersion });
    executionVersion = rotation.version; executionSecret = rotation.secret;
    const removed = await agentApi.fetch(`https://test/v1/sessions/${id}/execution`, {
      method: "PATCH", headers: { Authorization: `Bearer ${backend}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: executionSecret, expectedRevision: 1 }),
    });
    assert.equal(removed.status, 404);
    const revoked = await gatewayApi.fetch(`https://test/v1/machines/${machineId}`, { headers: { Authorization: `Bearer ${credential.token}` } });
    assert.equal(revoked.status, 401);
  }
  assert.equal(images.posts, 2);
});
