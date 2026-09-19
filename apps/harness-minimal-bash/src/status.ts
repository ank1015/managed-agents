import { MINIMAL_BASH_ROUTE } from "@managed-agents/harness-minimal-bash";
import type { SessionStatus } from "@managed-agents/contracts";
import type { Env } from "./types.ts";

export async function publishStatus(env: Env, sessionId: string, status: SessionStatus, revision: number): Promise<void> {
  await env.SESSION_DIRECTORY.prepare(`UPDATE sessions SET status = ?, status_revision = ?, status_checked_at = ?
    WHERE session_id = ? AND route_key = ? AND creation_state = 'ready' AND status_revision <= ?`)
    .bind(status, revision, Date.now(), sessionId, MINIMAL_BASH_ROUTE, revision).run();
}
/** Cron repairs failed/lost post-transition writes, including after object eviction. D1 is a projection only. */
export async function recoverStatuses(env: Env): Promise<void> {
  const rows = await env.SESSION_DIRECTORY.prepare(`SELECT session_id FROM sessions WHERE route_key = ? AND creation_state = 'ready'
    ORDER BY status_checked_at, session_id LIMIT 100`).bind(MINIMAL_BASH_ROUTE).all<{ session_id: string }>();
  for (let i = 0; i < rows.results.length; i += 10) {
    await Promise.all(rows.results.slice(i, i + 10).map(async row => {
      // Advance even on failure so one unavailable session cannot starve the others.
      await env.SESSION_DIRECTORY.prepare("UPDATE sessions SET status_checked_at = ? WHERE session_id = ?").bind(Date.now(), row.session_id).run();
      try { await deadline(env.MINIMAL_BASH_SESSIONS.get(env.MINIMAL_BASH_SESSIONS.idFromName(row.session_id)).publishStatus()); }
      catch { console.error("Minimal bash directory status refresh failed."); }
    }));
  }
}
export async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Status publication timed out.")), 10_000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
