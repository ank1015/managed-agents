import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import type { CreateSessionResult, InputReceipt, ListSessionsResult } from "@managed-agents/contracts";
import { LOCAL_BACKEND_TOKEN, startLocalStack } from "./local-stack.ts";

const config = { provider: "openai", modelId: "gpt-5.6-sol", accountId: "11111111-1111-4111-8111-111111111111", machineId: "22222222-2222-4222-8222-222222222222", cwd: "/workspace" };
let app: Miniflare;
before(async () => { app = await startLocalStack({ testHost: true }); });
after(async () => { await app?.dispose(); });
const createBody = (requestId: string, configValue: unknown = config, metadata: Record<string, unknown> = { key: requestId }) =>
  ({ requestId, harness: { id: "minimal-bash", version: "v7" }, config: configValue, metadata });
const input = (eventId: string, type = "minimal_bash.message", text = eventId) => ({ eventId, event: { type, payload: { message: { role: "user", content: [{ type: "text", text }] } } } });
async function request<T = Record<string, unknown>>(instance: Miniflare, path: string, method = "GET", value?: unknown, expected = 200, token = LOCAL_BACKEND_TOKEN): Promise<T> {
  const response = await instance.dispatchFetch(`https://api${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return result as T;
}
const create = (instance: Miniflare, key: string, configValue: unknown = config, expected = 201, metadata: Record<string, unknown> = { key }) =>
  request<CreateSessionResult>(instance, "/v1/sessions", "POST", createBody(key, configValue, metadata), expected);
const sessionPath = (id: string, suffix = "") => `/v1/sessions/${id}${suffix ? `/${suffix}` : ""}`;
const directory = (instance: Miniflare) => instance.getD1Database("SESSION_DIRECTORY", "managed-agents-agent-api");
test("public flow: retryable creation and input admission", async () => {
  const first = await create(app, "flow", config);
  const id = first.session.identity.sessionId;
  assert.match(id, /^ses_[a-f0-9-]{36}$/); assert.equal(first.duplicate, false);
  assert.deepEqual(await create(app, "flow", config, 200), { ...first, duplicate: true });
  const listed = await request<ListSessionsResult>(app, "/v1/sessions");
  assert.deepEqual(listed.sessions.find(session => session.sessionId === id), {
    sessionId: id, harness: { id: "minimal-bash", version: "v7" }, metadata: { key: "flow" }, status: "idle",
  });
  const receipt = await request<InputReceipt>(app, sessionPath(id, "inputs"), "POST", input("echo"), 202);
  assert.deepEqual(await request(app, sessionPath(id, "inputs"), "POST", input("echo"), 202), { ...receipt, duplicate: true });

});

test("concurrent same-key creation reserves one session and globally rejects conflicts", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await app.dispatchFetch("https://api/v1/sessions", { method: "POST", headers: { Authorization: `Bearer ${LOCAL_BACKEND_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(createBody("concurrent")) });
    assert.ok([200, 201].includes(response.status)); return response.json() as Promise<CreateSessionResult>;
  }));
  assert.equal(new Set(results.map(r => r.session.identity.sessionId)).size, 1);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  const id = results[0]!.session.identity.sessionId;
  await create(app, "concurrent", { ...config, cwd: "/changed" }, 409);
  await request(app, "/v1/sessions", "POST", { ...createBody("concurrent"), harness: { id: "unknown", version: "v7" } }, 409);
  await request(app, "/v1/sessions", "POST", { ...createBody("new-unsupported"), harness: { id: "unknown", version: "v7" } }, 400);
  const other = await create(app, "different-request");
  assert.notEqual(other.session.identity.sessionId, id);
  // Object key order is not part of the retry identity.
  await request(app, "/v1/sessions", "POST", { metadata: { key: "concurrent" }, config, harness: { version: "v7", id: "minimal-bash" }, requestId: "concurrent" });
});

test("backend auth is required and removed public routes stay unavailable", async () => {
  const { session } = await create(app, "authorization"); const id = session.identity.sessionId;
  assert.equal((await app.dispatchFetch(`https://api${sessionPath(id)}`)).status, 401);
  await request(app, sessionPath(id), "GET", undefined, 401, "wrong");
  await request(app, sessionPath(id), "GET", undefined, 404);
  await request(app, sessionPath("missing"), "GET", undefined, 404);
  for (const suffix of ["outputs", "progress", "operations/nope"]) {
    await request(app, sessionPath(id, suffix), "GET", undefined, 404);
  }
  await request(app, `/v1/provider-callbacks/retired-provider/sessions/${id}`, "POST", {}, 404);
  for (const suffix of ["run", "resume", "state", "initialize"]) await request(app, sessionPath(id, suffix), "POST", {}, 404);
  await request(app, `/fixtures/${id}`, "GET", undefined, 404);
});

test("directory retains only a canonical request hash and creation retries preserve harness status", async () => {
  const metadata = { nested: { z: 1, a: 2 }, values: [1, 2] };
  const created = await create(app, "hashed", config, 201, metadata);
  const id = created.session.identity.sessionId;
  const db = await directory(app);
  const row = await db.prepare("SELECT * FROM sessions WHERE session_id = ?").bind(id).first();
  assert.match(row!.creation_request_hash as string, /^[a-f0-9]{64}$/);
  for (const removed of ["creation_request_json", "creation_state", "status_revision", "status_checked_at"]) assert.equal(removed in row!, false);
  assert.equal(JSON.stringify(row).includes(config.accountId), false);
  assert.equal((created.session.config as { reasoning: string }).reasoning, "medium");
  await db.prepare("UPDATE sessions SET status = 'running' WHERE session_id = ?").bind(id).run();
  await create(app, "hashed", config, 200, { values: [1, 2], nested: { a: 2, z: 1 } });
  assert.equal((await db.prepare("SELECT status FROM sessions WHERE session_id = ?").bind(id).first())!.status, "running");
  await create(app, "hashed", config, 409, { ...metadata, values: [2, 1] });
  await create(app, "hashed", { ...config, reasoning: "medium" }, 409, metadata);
  await db.prepare("UPDATE sessions SET status = 'destroyed' WHERE session_id = ?").bind(id).run();
  await create(app, "hashed", config, 409, metadata);
  await request(app, sessionPath(id, "inputs"), "POST", input("retired"), 409);
});

test("validation errors survive RPC and input conflicts are rejected", async () => {
  const { session } = await create(app, "validation"); const id = session.identity.sessionId;
  await request(app, sessionPath(id, "inputs"), "POST", input("echo", "minimal_bash.message"), 202);
  await request(app, sessionPath(id, "inputs"), "POST", input("echo", "minimal_bash.message", "changed"), 409);
  for (const value of [input("runtime:spoof"), input("bad", "runtime.operation.completed"), input("bad", "unknown"), { ...input("bad"), sequence: 5 }]) {
    await request(app, sessionPath(id, "inputs"), "POST", value, 400);
  }

});

test("invalid creation config is a stable failure; corrected content needs a new key", async () => {
  await create(app, "invalid-config", { unsupported: true }, 400);
  await create(app, "invalid-config", { unsupported: true }, 400);
  await create(app, "invalid-config", config, 409);
  const row = await (await directory(app)).prepare("SELECT session_id, status FROM sessions WHERE creation_request_id = ?").bind("invalid-config").first();
  assert.equal(row!.status, "initialization_failed");
  const failed = (await request<ListSessionsResult>(app, "/v1/sessions")).sessions.find(session => session.sessionId === row!.session_id);
  assert.equal(failed?.status, "initialization_failed");
  await create(app, "valid-new-key");
});

for (const label of ["fault-before-initialize", "fault-after-initialize"]) {
  test(`creation recovers across restart: ${label}`, async () => {
    const path = await mkdtemp(join(tmpdir(), "agent-api-create-"));
    const options = { persistPath: path, testHost: true };
    let instance = await startLocalStack(options);
    try {
      await create(instance, "retry-creation", { ...config, cwd: `/${label}` }, 503);
      const before = await (await directory(instance)).prepare("SELECT * FROM sessions WHERE creation_request_id = 'retry-creation'").first();
      assert.equal(before!.status, "initializing");
      await request(instance, sessionPath(before!.session_id as string, "inputs"), "POST", input("too-early"), 409);
      await instance.dispose(); instance = await startLocalStack(options);
      const recovered = await create(instance, "retry-creation", { ...config, cwd: `/${label}` }, 200);
      assert.equal(recovered.session.identity.sessionId, before!.session_id); assert.equal(recovered.duplicate, true);
      const after = await (await directory(instance)).prepare("SELECT * FROM sessions").all();
      assert.equal(after.results.length, 1); assert.equal(after.results[0]!.status, "idle");
    } finally { await instance.dispose(); await rm(path, { recursive: true, force: true }); }
  });
}

test("restart preserves lost create/input responses", async () => {
  const path = await mkdtemp(join(tmpdir(), "agent-api-restart-"));
  const options = { persistPath: path, testHost: true };
  let instance = await startLocalStack(options);
  try {
    const first = await create(instance, "lost-response"); const id = first.session.identity.sessionId;
    const receipt = await request(instance, sessionPath(id, "inputs"), "POST", input("echo"), 202);
    await instance.dispose(); instance = await startLocalStack(options);
    assert.deepEqual(await create(instance, "lost-response", config, 200), { ...first, duplicate: true });
    assert.deepEqual(await request(instance, sessionPath(id, "inputs"), "POST", input("echo"), 202), { ...receipt, duplicate: true });
  } finally { await instance.dispose(); await rm(path, { recursive: true, force: true }); }
});

test("HTTP errors, body limits and missing credentials fail closed", async () => {
  const auth = { Authorization: `Bearer ${LOCAL_BACKEND_TOKEN}`, "Content-Type": "application/json" };
  assert.equal((await app.dispatchFetch("https://api/v1/sessions", { method: "POST", headers: auth, body: "{" })).status, 400);
  assert.equal((await app.dispatchFetch("https://api/v1/sessions", { method: "POST", headers: auth, body: JSON.stringify({ text: "x".repeat(65536) }) })).status, 413);
  assert.equal((await app.dispatchFetch("https://api/v1/sessions", { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
  const response = await app.dispatchFetch("https://api/v1/sessions", { method: "PUT", headers: auth });
  assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "GET or POST");
  await request(app, "/v1/sessions/%ZZ/inputs", "POST", {}, 400);
  assert.equal((await app.dispatchFetch("https://api/health")).status, 200);
  const unconfigured = await startLocalStack({ backendToken: "" });
  try {
    await request(unconfigured, "/v1/sessions", "POST", createBody("missing-auth"), 503);
    const host = await unconfigured.getWorker("managed-agents-harness-minimal-bash-v7");
    assert.equal((await host.fetch("https://host/fixtures/anything")).status, 404);
  } finally { await unconfigured.dispose(); }
});
