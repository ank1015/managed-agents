import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";

export const LOCAL_BACKEND_TOKEN = "local-test-backend-token-not-for-deployment";
export interface StackOptions {
  persistPath?: string;
  testHost?: boolean;
  backendToken?: string;
}
async function bundle(url: URL): Promise<string> {
  const result = await build({ entryPoints: [fileURLToPath(url)], bundle: true, format: "esm", platform: "browser",
    target: "es2022", external: ["cloudflare:workers"], write: false });
  return result.outputFiles[0]!.text;
}

/** Test-only API + minimal-bash host + fake operations. Never calls live gateways. */
export async function startLocalStack(options: StackOptions = {}): Promise<Miniflare> {
  const [apiConfig, hostConfig] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../harness-minimal-bash/wrangler.jsonc", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const [apiScript, hostScript, fixtureScript] = await Promise.all([
    bundle(new URL(`../${apiConfig.main}`, import.meta.url)),
    bundle(options.testHost ? new URL("../test/fault-host.ts", import.meta.url) : new URL(`../../harness-minimal-bash/${hostConfig.main}`, import.meta.url)),
    bundle(new URL("../../harness-minimal-bash/test/fixture.ts", import.meta.url)),
  ]);
  const apiName = apiConfig.name as string, hostName = hostConfig.name as string;
  const api = {
    name: apiName, modules: true, script: apiScript, compatibilityDate: apiConfig.compatibility_date as string,
    bindings: { BACKEND_TOKEN: options.backendToken ?? LOCAL_BACKEND_TOKEN },
    d1Databases: Object.fromEntries(apiConfig.d1_databases.map((b: { binding: string; database_id: string }) => [b.binding, b.database_id])),
    durableObjects: Object.fromEntries(apiConfig.durable_objects.bindings.filter((b: { script_name: string }) => b.script_name === hostName)
      .map((b: { name: string; class_name: string; script_name: string }) => [b.name, { className: b.class_name, scriptName: b.script_name }])),
  };
  const host = {
    name: hostName, modules: true, script: hostScript, compatibilityDate: hostConfig.compatibility_date as string,
    d1Databases: api.d1Databases,
    serviceBindings: { LLM: { name: "operations", entrypoint: "FakeOperations" }, BASH: { name: "operations", entrypoint: "FakeOperations" } },
    durableObjects: Object.fromEntries(hostConfig.durable_objects.bindings.map((b: { name: string; class_name: string }) => {
      return [b.name, { className: b.class_name, useSQLite: true }];
    })),
  };
  const app = new Miniflare({ log: new Log(LogLevel.ERROR), outboundService: () => { throw new Error("Tests must not call external services."); }, workers: [api, host, { name: "operations", modules: true, script: fixtureScript, compatibilityDate: hostConfig.compatibility_date, d1Databases: api.d1Databases, durableObjects: { ...api.durableObjects, JOBS: { className: "FakeJobs", useSQLite: true } } }],
    ...(options.persistPath ? { durableObjectsPersist: `${options.persistPath}/objects`, d1Persist: `${options.persistPath}/d1` } : {}),
  });
  try {
    const db = await app.getD1Database("SESSION_DIRECTORY", apiName);
    const exists = await db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").first();
    if (!exists) {
      const sql = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
      for (const statement of sql.split(";").filter(s => s.trim())) await db.prepare(statement).run();
    }
    return app;
  } catch (error) { await app.dispose(); throw error; }
}
