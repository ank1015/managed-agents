import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function config(name: string) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

test("bootstrap keeps the same Machine namespace but cannot take traffic or route callbacks", () => {
  const live = config("wrangler.jsonc"), bootstrap = config("wrangler.bootstrap.jsonc");
  assert.equal(live.vars.MAX_CONCURRENT_DELIVERIES, "16");
  assert.equal(live.vars.MAX_BUFFERED_BYTES, "16777216");
  const { routes: liveRoutes, services: liveServices, vars: liveVars, ...liveIdentity } = live;
  const { routes, services, vars, ...bootstrapIdentity } = bootstrap;
  assert.deepEqual(bootstrapIdentity, liveIdentity);
  assert.equal(bootstrap.workers_dev, false);
  assert.equal(bootstrap.preview_urls, false);
  assert.deepEqual(routes, []);
  assert.deepEqual(services, []);
  assert.deepEqual(vars, { ...liveVars, CALLBACK_ROUTES: "{}" });
  assert.deepEqual(liveRoutes, [{ pattern: "execution-api.acentric.dev", custom_domain: true }]);
  const receivers = Object.values(JSON.parse(liveVars.CALLBACK_ROUTES)).sort();
  assert.equal(receivers.length, 5);
  assert.deepEqual(receivers, liveServices.map((s: { binding: string }) => s.binding).sort());
});
