import { DurableObject } from "cloudflare:workers";
import { ContractException, parseInitializeSessionRequest, parseSessionCommand, parseProviderStatusResult, parseProviderSubmitResult } from "@managed-agents/contracts";
import { MINIMAL_BASH_ROUTE, minimalBashHarness, readMinimalBashMessages, readMinimalBashState, readPendingMessages } from "@managed-agents/harness-minimal-bash";
import type { MinimalBashConfig, MinimalBashInput } from "@managed-agents/harness-minimal-bash";
import { SessionDriver } from "@managed-agents/session-runtime";
import type { OperationProvider } from "@managed-agents/session-runtime";
import { deadline, publishStatus } from "./status.ts";
import type { Env } from "./types.ts";

export class MinimalBashSession extends DurableObject<Env> {
  readonly #driver: SessionDriver<MinimalBashConfig, MinimalBashInput>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const adapter = (binding: Env["LLM"]): OperationProvider => ({
      submit: async submission => parseProviderSubmitResult(JSON.parse(await binding.submit(JSON.stringify({
        destination: { routeKey: MINIMAL_BASH_ROUTE, sessionId: this.#driver.getSession().identity.sessionId }, submission,
      })))),
      get: async query => parseProviderStatusResult(JSON.parse(await binding.get(JSON.stringify(query)))),
    });
    this.#driver = new SessionDriver(ctx.storage, minimalBashHarness, {
      providers: { llm: adapter(env.LLM), "tool-pi-bash": adapter(env.BASH) },
      waitUntil: promise => ctx.waitUntil(promise.finally(() => this.#publishSafely())),
    });
    // Host-owned projection sequence, independent of harness state and runtime operation tables.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS minimal_bash_host_status (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), status TEXT NOT NULL, revision INTEGER NOT NULL
    )`).toArray();
  }
  async alarm(): Promise<void> { try { await this.#driver.alarm(); } finally { await this.#publishSafely(); } }
  async #publishSafely(): Promise<void> {
    try { await deadline(this.publishStatus()); }
    catch { console.error("Minimal bash status publication failed; scheduled recovery will retry."); }
  }
  async publishStatus(): Promise<void> {
    const session = this.#driver.getSession();
    const snapshot = this.ctx.storage.transactionSync(() => {
      const state = readMinimalBashState(this.ctx.storage.sql);
      const status = this.#driver.getProcessingStatus().blocked ? "failed" : state.status;
      const row = this.ctx.storage.sql.exec<{ status: string; revision: number }>("SELECT status, revision FROM minimal_bash_host_status WHERE singleton = 1").toArray()[0];
      const revision = row ? row.revision + (row.status === status ? 0 : 1) : 1;
      if (!Number.isSafeInteger(revision)) throw new Error("Status revision exhausted.");
      this.ctx.storage.sql.exec(`INSERT INTO minimal_bash_host_status VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET status = excluded.status, revision = excluded.revision`, status, revision).toArray();
      return { status, revision };
    });
    await publishStatus(this.env, session.identity.sessionId, snapshot.status, snapshot.revision);
  }
  /** Trusted service/DO bindings only. No public session HTTP or callback routes. */
  async sessionRequest(serialized: string): Promise<string> {
    try {
      const command = parseSessionCommand(JSON.parse(serialized));
      let value: unknown;
      switch (command.action) {
        case "initialize": {
          const request = parseInitializeSessionRequest(command.value);
          if (!this.ctx.id.equals(this.env.MINIMAL_BASH_SESSIONS.idFromName(request.session.sessionId))) throw new ContractException("INVALID_REQUEST", "Session ID does not match the addressed Durable Object.");
          value = await this.#driver.initialize(request); break;
        }
        case "appendInput": value = await this.#driver.appendInput(command.value); break;
        case "acceptCompletion": value = await this.#driver.acceptCompletion(command.value); break;
        case "getSession": value = this.#driver.getSession(); break;
        case "getProgress": this.#driver.getSession(); value = this.#driver.getProcessingStatus(); break;
        case "getOperation": value = this.#driver.getOperation(command.value); break;
        case "getMessages": case "getPendingMessages": {
          this.#driver.getSession();
          const read = command.action === "getMessages" ? readMinimalBashMessages : readPendingMessages;
          const page = read(this.ctx.storage.sql, command.value.after, command.value.limit);
          const processingBlocked = this.#driver.getProcessingStatus().blocked;
          value = { ...page, state: { ...page.state, status: processingBlocked ? "failed" : page.state.status, processingBlocked } };
          break;
        }
      }
      return JSON.stringify({ ok: true, value });
    } catch (error) {
      if (error instanceof ContractException) return JSON.stringify({ ok: false, error: error.toJSON() });
      throw error;
    }
  }
}
