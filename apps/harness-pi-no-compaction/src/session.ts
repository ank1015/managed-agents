import { SessionExecution } from "@managed-agents/session-execution";
import { DurableObject } from "cloudflare:workers";
import { Logger } from "@managed-agents/diagnostics";
import { ContractException, parseInitializeSessionRequest, parseSessionCommand, parseProviderSubmitReply } from "@managed-agents/contracts";
import type { SessionReply, SessionInfo } from "@managed-agents/contracts";
import { PI_NO_COMPACTION_ROUTE, piNoCompactionHarness, readPiNoCompactionMessages, readPendingMessages } from "@managed-agents/harness-pi-no-compaction";
import type { PiNoCompactionConfig, PiNoCompactionInput } from "@managed-agents/harness-pi-no-compaction";
import { SessionDriver } from "@managed-agents/session-runtime";
import type { OperationProvider } from "@managed-agents/session-runtime";
import { StatusPublisher } from "./status.ts";
import type { Env } from "./types.ts";

export class PiNoCompactionSessionV1 extends DurableObject<Env> {
  readonly #execution: SessionExecution;
  readonly #driver: SessionDriver<PiNoCompactionConfig, PiNoCompactionInput>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#execution = new SessionExecution(ctx.storage, env.EXECUTION_GATEWAY_URL);
    const adapter = (binding: Env["LLM"], tool = false): OperationProvider => ({
      submit: async submission => {
        const session = this.#driver.getSession();
        const destination = { routeKey: PI_NO_COMPACTION_ROUTE, sessionId: session.identity.sessionId };
        if (tool) return this.#execution.submit(binding, destination, submission, session.config as unknown as PiNoCompactionConfig);
        return parseProviderSubmitReply(await binding.submit({ destination, submission }));
      },
    });
    const diagnostics = new Logger("harness-host", env);
    const statuses = new StatusPublisher(env.SESSION_DIRECTORY, promise => ctx.waitUntil(promise), diagnostics);
    this.#driver = new SessionDriver(ctx.storage, piNoCompactionHarness, {
      providers: { llm: adapter(env.LLM), "tool-pi-bash": adapter(env.BASH, true), "tool-pi-read": adapter(env.READ, true), "tool-pi-edit": adapter(env.EDIT, true), "tool-pi-write": adapter(env.WRITE, true) },
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
          const initialized = await this.#driver.initialize(request);
          value = { ...initialized, session: sessionView(initialized.session) }; break;
        }
        case "appendInput": value = await this.#driver.appendInput(command.value); break;
        case "acceptToolCompletion": value = await this.#driver.acceptCompletion(this.#execution.toolCompletion(command.value)); break;
        case "acceptCompletion": {
          if ((command.value as { provider?: unknown })?.provider !== "llm") throw new ContractException("INVALID_REQUEST", "Tool completions require execution identity.");
          value = await this.#driver.acceptCompletion(command.value); break;
        }
        case "getSession": value = sessionView(this.#driver.getSession()); break;
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

/** Config remains intact in storage; only host response projection omits credentials. */
function sessionView(session: SessionInfo): SessionInfo {
  const { executionToken: omitted, ...config } = session.config as unknown as PiNoCompactionConfig;
  return { ...session, config };
}
