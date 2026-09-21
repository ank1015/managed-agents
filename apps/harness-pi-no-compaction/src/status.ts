import type { HarnessStatus } from "@managed-agents/contracts";
import { Logger } from "@managed-agents/diagnostics";
import { PI_NO_COMPACTION_ROUTE } from "@managed-agents/harness-pi-no-compaction";

/** Ordered within an activation; best-effort across failures/restarts. No durable
 * publication state, retries, or idle refreshes. */
export class StatusPublisher {
  #tail: Promise<void> = Promise.resolve();
  constructor(readonly db: D1Database, readonly waitUntil: (promise: Promise<void>) => void,
    readonly logger = new Logger("harness-host")) {}

  publish(sessionId: string, status: HarnessStatus): void {
    this.#tail = this.#tail.then(async () => {
      await this.db.prepare(`UPDATE sessions SET status = ? WHERE session_id = ? AND route_key = ?
        AND status NOT IN ('initializing', 'initialization_failed', 'destroyed')`)
        .bind(status, sessionId, PI_NO_COMPACTION_ROUTE).run();
    }).catch(() => { this.logger.error("status_publish_failed", {
      sessionId, stage: "status", errorCode: "D1_STATUS_UPDATE_FAILED", retryable: false,
    }); });
    this.waitUntil(this.#tail);
  }
}
