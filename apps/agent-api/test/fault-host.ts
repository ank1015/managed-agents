// Test-only host: simulate interruption immediately before/after object initialization.
import { MinimalBashSessionV7 as BaseSession } from "../../harness-minimal-bash/src/session.ts";
import { parseSessionCommand } from "@managed-agents/contracts";
import type { SessionReply } from "@managed-agents/contracts";
export { default } from "../../harness-minimal-bash/src/index.ts";

export class MinimalBashSessionV7 extends BaseSession {
  override async sessionRequest(value: unknown): Promise<SessionReply<unknown>> {
    const command = parseSessionCommand(value);
    const label = command.action === "initialize" ? (command.value as { config?: { cwd?: string } })?.config?.cwd : undefined;
    const fault = label === "/fault-before-initialize" || label === "/fault-after-initialize";
    const first = fault && !await this.ctx.storage.get<boolean>("test-fault-fired");
    if (first) await this.ctx.storage.put("test-fault-fired", true);
    if (first && label === "/fault-before-initialize") throw new Error("Test interruption before initialization");
    const result = await super.sessionRequest(value);
    if (first && label === "/fault-after-initialize") throw new Error("Test lost initialization response");
    return result;
  }
}
