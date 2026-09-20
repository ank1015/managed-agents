import assert from "node:assert/strict";
import { test } from "node:test";
import { Logger } from "@managed-agents/diagnostics";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/status.ts", import.meta.url))], bundle: true,
  format: "esm", platform: "node", write: false });
const { StatusPublisher } = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0]!.text).toString("base64")) as { StatusPublisher: new (db: unknown, waitUntil: (p: Promise<void>) => void, logger: Logger) => { publish(sessionId: string, status: string): void } };

test("status publication failure remains best-effort and emits only correlation metadata", async () => {
  const records: unknown[] = [], pending: Promise<void>[] = [];
  const db = { prepare() { throw new Error("private SQL or prompt"); } };
  const logger = new Logger("harness-host", {}, (_level, record) => records.push(record));
  const publisher = new StatusPublisher(db, promise => pending.push(promise), logger);
  const sessionId = "ses_11111111-1111-4111-8111-111111111111";
  publisher.publish(sessionId, "idle"); await Promise.all(pending);
  assert.deepEqual(records, [{ service: "harness-host", event: "status_publish_failed",
    stage: "status", errorCode: "D1_STATUS_UPDATE_FAILED", sessionId, retryable: false }]);
});
