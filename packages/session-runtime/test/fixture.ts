import type { DurableObjectState } from "@cloudflare/workers-types";
import { ContractException } from "@managed-agents/contracts";
import type { EventBody } from "@managed-agents/contracts";
import type { HarnessInitializationContext, HarnessDefinition, TransitionPlan } from "@managed-agents/harness-api";
import { SessionRuntime } from "../src/index.ts";

interface Config { label: string; settings: { enabled: boolean } }
interface Options {
  init?: "fail" | "async" | "return";
  config?: "reject" | "invalid" | "async";
  input?: "reject" | "mutate" | "rewrite" | "async";
  fixed?: boolean;
  labelDefault?: string;
  identity?: { id: string; version: string };
  schema?: string[];
}
export const schema = [
  "CREATE TABLE h_counter (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), count INTEGER NOT NULL)",
  "CREATE TABLE h_messages (event_id TEXT PRIMARY KEY, text TEXT NOT NULL)",
];

/** Test-only host: exposes SQL and deliberately broken harnesses. Never deploy. */
export class RuntimeFixture {
  readonly state: DurableObjectState;
  readonly activation = crypto.randomUUID();
  runtime: SessionRuntime<Config, EventBody> | undefined;
  options: Options = {};
  configCalls = 0;
  inputCalls = 0;
  retained: HarnessInitializationContext<Config> | undefined;
  lateError: string | undefined;

  constructor(state: DurableObjectState) { this.state = state; }

  createRuntime(): SessionRuntime<Config, EventBody> {
    const definition: HarnessDefinition<Config, EventBody> = {
      identity: this.options.identity ?? { id: "fixture", version: "v1" },
      operations: [],
      schema: this.options.schema ?? schema,
      parseConfig: value => {
        this.configCalls++;
        if (this.options.config === "reject") throw new ContractException("INVALID_CONFIG", "bad config");
        if (this.options.config === "invalid") return { label: undefined } as unknown as Config;
        if (this.options.config === "async") return Promise.resolve({}) as unknown as Config;
        if (value === null || typeof value !== "object" || Array.isArray(value)
          || (value.label !== undefined && typeof value.label !== "string")) {
          throw new ContractException("INVALID_CONFIG", "Expected optional string label.");
        }
        return { label: value.label ?? this.options.labelDefault ?? "default", settings: { enabled: true } };
      },
      parseInput: event => {
        this.inputCalls++;
        if (this.options.input === "reject") throw new ContractException("INVALID_INPUT", "rejected");
        if (this.options.input === "async") return Promise.resolve(event) as unknown as EventBody;
        if (this.options.input === "mutate") { event.payload = "changed"; return event; }
        if (this.options.input === "rewrite") return { ...event, payload: "changed" };
        if (!["record", "fail", "mutate", "retain", "late", "return-value", "reenter"].includes(event.type)) {
          throw new ContractException("INVALID_INPUT", "Unsupported type.");
        }
        return event;
      },
      initialize: ctx => {
        this.retained = ctx;
        ctx.sql.exec("INSERT INTO h_counter VALUES (1, 0)").toArray();
        if (this.options.init === "fail") throw new Error("initialization failed");
        if (this.options.init === "async") return Promise.resolve() as unknown as undefined;
        if (this.options.init === "return") return 42 as unknown as undefined;
      },
      handle: (input, ctx) => {
        this.retained = ctx;
        if (input.event.type === "fail" && !this.options.fixed) throw new Error("handler failed");
        if (input.event.type === "mutate") ctx.config.settings.enabled = false;
        if (input.event.type === "return-value") return 42 as unknown as TransitionPlan<unknown>;
        if (input.event.type === "reenter") this.runtime!.prepareNext();
        if (input.event.type === "late") {
          const promise = Promise.resolve().then(() => {
            try { ctx.sql.exec("UPDATE h_counter SET count = 999"); }
            catch (error) { this.lateError = (error as Error).message; throw error; }
          });
          return promise as unknown as TransitionPlan<unknown>;
        }
        return { changes: { eventId: input.eventId, payload: input.event.payload }, operations: [] };
      },
      apply(changes, ctx) {
        const c = changes as { eventId: string; payload: unknown };
        ctx.sql.exec("INSERT INTO h_messages VALUES (?, ?)", c.eventId, JSON.stringify(c.payload));
        ctx.sql.exec("UPDATE h_counter SET count = count + 1");
      },
    };
    return new SessionRuntime(this.state.storage, definition);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const command = await request.json() as { op: string; value?: unknown };
      if (command.op === "configure") {
        this.options = command.value as Options;
        this.runtime = undefined;
        return Response.json({ ok: true });
      }
      if (command.op === "sql") {
        const { query, bindings = [] } = command.value as { query: string; bindings?: (string | number | null)[] };
        return Response.json(this.state.storage.sql.exec(query, ...bindings).toArray());
      }
      if (command.op === "stats") return Response.json({ configCalls: this.configCalls, inputCalls: this.inputCalls, activation: this.activation, lateError: this.lateError ?? null });
      if (command.op === "expired-sql") return Response.json(this.retained!.sql.exec("UPDATE h_counter SET count = 999").toArray());
      this.runtime ??= this.createRuntime();
      switch (command.op) {
        case "start": return Response.json({ ok: true });
        case "initialize": return Response.json(this.runtime.initialize(command.value));
        case "appendInput": return Response.json(this.runtime.appendInput(command.value));
        case "processNext": { const p = this.runtime.prepareNext(); return Response.json(p ? this.runtime.commit(p, []) : { processed: false }); }
        case "getSession": return Response.json(this.runtime.getSession());
        case "mutate-read": {
          const info = this.runtime.getSession();
          info.identity.harness.id = "changed";
          (info.config as { label: string }).label = "changed";
          return Response.json(this.runtime.getSession());
        }
        default: throw new Error("Unknown test command.");
      }
    } catch (error) {
      return Response.json({ error: { message: (error as Error).message, code: error instanceof ContractException ? error.code : null } }, { status: 400 });
    }
  }
}
