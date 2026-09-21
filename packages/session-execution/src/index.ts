import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { ContractException, parseProviderSubmitReply } from "@managed-agents/contracts";
import type { ProviderSubmission, ProviderSubmitResult, SessionDestination } from "@managed-agents/contracts";
import { object, uuid } from "@managed-agents/execution-gateway-protocol";

interface RuntimeBinding { machineId: string; runtimeGeneration: string; destination: SessionDestination }
interface ExecutionConfig { machineId: string; executionToken: string }

/** Pins transport runtime only. Credentials come from the immutable harness configuration. */
export class SessionExecution {
  private preparing: Promise<void> | undefined;
  constructor(private storage: DurableObjectStorage, private gatewayUrl: string) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS host_execution_runtime (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), runtime TEXT NOT NULL)`);
  }
  private runtime(): RuntimeBinding | undefined {
    const row = this.storage.sql.exec<{ runtime: string }>("SELECT runtime FROM host_execution_runtime WHERE singleton = 1").toArray()[0];
    return row ? JSON.parse(row.runtime) as RuntimeBinding : undefined;
  }
  private async http(path: string, token: string): Promise<Record<string, unknown>> {
    const url = new URL(this.gatewayUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("Invalid execution gateway origin.");
    const response = await fetch(`${url.origin}${path}`, { method: "GET", redirect: "manual",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(7000),
    });
    // No remote error text or credentials enter runtime diagnostics.
    if (!response.ok) throw Error(`Execution discovery request failed (HTTP ${response.status}).`);
    const text = await response.text();
    if (text.length > 65536) throw Error("Execution discovery reply exceeds limit.");
    return object(JSON.parse(text));
  }
  private async prepare(destination: SessionDestination, machineId: string, token: string): Promise<void> {
    if (this.runtime()) return;
    const response = await this.http(`/v1/machines/${machineId}`, token), machine = object(response.machine);
    if (machine.machineId !== machineId || machine.connectionStatus !== "ready") throw Error("Execution machine is not ready.");
    const runtime: RuntimeBinding = { machineId, runtimeGeneration: uuid(machine.runtimeGeneration), destination };
    // Persist before dispatch: completion may arrive before submission returns.
    this.storage.sql.exec("INSERT INTO host_execution_runtime(singleton, runtime) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING", JSON.stringify(runtime));
  }
  async submit(binding: { submit(value: unknown): Promise<unknown> }, destination: SessionDestination, submission: ProviderSubmission, config: ExecutionConfig): Promise<ProviderSubmitResult> {
    const input = object(submission.request.input), machineId = uuid(input.machineId);
    if (config.machineId !== machineId) throw new ContractException("INVALID_REQUEST", "Operation machine differs from the immutable configuration.");
    if (!this.runtime()) {
      this.preparing ??= this.prepare(destination, machineId, config.executionToken).finally(() => { this.preparing = undefined; });
      await this.preparing;
    }
    const runtime = this.runtime()!;
    if (runtime.machineId !== machineId || runtime.destination.sessionId !== destination.sessionId || runtime.destination.routeKey !== destination.routeKey) throw Error("Execution runtime identity mismatch.");
    return parseProviderSubmitReply(await binding.submit({ destination, submission, execution: {
      token: config.executionToken, runtimeGeneration: runtime.runtimeGeneration,
    } }));
  }
  /** Check execution ownership before the driver checks this session's operation identity. */
  toolCompletion(value: unknown): unknown {
    let raw: Record<string, unknown>, execution: Record<string, unknown>;
    try {
      raw = object(value, ["execution", "completion"]);
      execution = object(raw.execution, ["machineId", "runtimeGeneration"]);
      object(raw.completion);
    } catch {
      throw new ContractException("COMPLETION_CONFLICT", "Malformed tool completion.");
    }
    const runtime = this.runtime();
    if (!runtime) throw new ContractException("COMPLETION_CONFLICT", "Tool completion arrived without an execution runtime.");
    if (execution.machineId !== runtime.machineId
      || execution.runtimeGeneration !== runtime.runtimeGeneration
      || !["tool-pi-bash", "tool-pi-read", "tool-pi-edit", "tool-pi-write"].includes(String(object(raw.completion).provider))) {
      throw new ContractException("COMPLETION_CONFLICT", "Tool completion execution identity does not belong to this session.");
    }
    return raw.completion;
  }
}
