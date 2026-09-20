import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("optimized storage keeps admission/commit transactions with fewer SQLite row writes", async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./storage-profile.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], write: false });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-07-30",
    durableObjects: { PROFILE: { className: "StorageProfile", useSQLite: true } } });
  try {
    const response = await mf.dispatchFetch("https://profile/");
    assert.equal(response.status, 200, await response.clone().text());
    const segments = await response.json() as { name: string; transactions: number; reads: number; writes: number }[];
    // Pre-optimization measurement of this identical workload: 100 writes / 17 transactions.
    assert.equal(segments.reduce((n, s) => n + s.writes, 0), 63);
    assert.equal(segments.reduce((n, s) => n + s.transactions, 0), 17);
    for (const s of segments.filter(s => s.name.endsWith(" prepare"))) assert.equal(s.writes, 0, s.name);
    for (const s of segments.filter(s => s.name.endsWith(" admit"))) {
      assert.equal(s.transactions, 1, s.name);
      assert.equal(s.writes, 3, s.name);
    }
    for (const s of segments.filter(s => s.name.endsWith(" commit"))) assert.equal(s.transactions, 1, s.name);
  } finally { await mf.dispose(); }
});
