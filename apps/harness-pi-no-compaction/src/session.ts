import { DurableObject } from "cloudflare:workers";
import { Logger } from "@managed-agents/diagnostics";
import { ContractException, parseInitializeSessionRequest, parseSessionCommand, parseProviderSubmitReply } from "@managed-agents/contracts";
import type { SessionReply } from "@managed-agents/contracts";
import { PI_NO_COMPACTION_ROUTE, piNoCompactionHarness, readPiNoCompactionMessages, readPendingMessages } from "@managed-agents/harness-pi-no-compaction";
import type { PiNoCompactionConfig, PiNoCompactionInput } from "@managed-agents/harness-pi-no-compaction";
import { SessionDriver } from "@managed-agents/session-runtime";
import type { OperationProvider } from "@managed-agents/session-runtime";
import { StatusPublisher } from "./status.ts";
import type { Env } from "./types.ts";

export class PiNoCompactionSessionV1 extends DurableObject<Env> {
  readonly #driver: SessionDriver<PiNoCompactionConfig, PiNoCompactionInput>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const adapter = (binding: Env["LLM"]): OperationProvider => ({
      submit: async submission => parseProviderSubmitReply(await binding.submit({
        destination: { routeKey: PI_NO_COMPACTION_ROUTE, sessionId: this.#driver.getSession().identity.sessionId }, submission,
      })),
    });
    const diagnostics = new Logger("harness-host", env);
    const statuses = new StatusPublisher(env.SESSION_DIRECTORY, promise => ctx.waitUntil(promise), diagnostics);
    this.#driver = new SessionDriver(ctx.storage, piNoCompactionHarness, {
      providers: { llm: adapter(env.LLM), "tool-pi-bash": adapter(env.BASH), "tool-pi-read": adapter(env.READ), "tool-pi-edit": adapter(env.EDIT), "tool-pi-write": adapter(env.WRITE) },
      diagnostics,
      waitUntil: promise => ctx.waitUntil(promise),
      onStatusChange: status => statuses.publish(this.#driver.getSession().identity.sessionId, status),
    });
  }
  async alarm(): Promise<void> { await this.#driver.alarm(); }
  /** Trusted service/DO bindings only. No public session HTTP or callback routes. */
  async sessionRequest(request: unknown): Promise<SessionReply<unknown>> {
    try {
      const command = parseSessionCommand(request);
      let value: unknown;
      switch (command.action) {
        case "initialize": {
          const request = parseInitializeSessionRequest(command.value);
          if (!this.ctx.id.equals(this.env.PI_NO_COMPACTION_SESSIONS.idFromName(request.session.sessionId))) throw new ContractException("INVALID_REQUEST", "Session ID does not match the addressed Durable Object.");
          value = await this.#driver.initialize(request); break;
        }
        case "appendInput": value = await this.#driver.appendInput(command.value); break;
        case "acceptCompletion": value = await this.#driver.acceptCompletion(command.value); break;
        case "getSession": value = this.#driver.getSession(); break;
        case "getProgress": this.#driver.getSession(); value = this.#driver.getProcessingStatus(); break;
        case "getMessages": case "getPendingMessages": {
          this.#driver.getSession();
          const read = command.action === "getMessages" ? readPiNoCompactionMessages : readPendingMessages;
          const page = read(this.ctx.storage.sql, command.value.after, command.value.limit);
          const processingBlocked = this.#driver.getProcessingStatus().blocked;
          value = { ...page, state: { ...page.state, processingBlocked } };
          break;
        }
      }
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ContractException) return { ok: false, error: error.toJSON() };
      throw error;
    }
  }
}
