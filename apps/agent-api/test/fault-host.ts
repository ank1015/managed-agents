// Test-only host: simulate interruption immediately before/after object initialization.
import { MinimalBashSession as BaseSession } from "../../harness-minimal-bash/src/session.ts";
export { default } from "../../harness-minimal-bash/src/index.ts";

export class MinimalBashSession extends BaseSession {
  override async sessionRequest(serialized: string): Promise<string> {
    const command = JSON.parse(serialized);
    const label = command.action === "initialize" ? command.value?.config?.cwd : undefined;
    const fault = label === "/fault-before-initialize" || label === "/fault-after-initialize";
    const first = fault && !await this.ctx.storage.get<boolean>("test-fault-fired");
    if (first) await this.ctx.storage.put("test-fault-fired", true);
    if (first && label === "/fault-before-initialize") throw new Error("Test interruption before initialization");
    const result = await super.sessionRequest(serialized);
    if (first && label === "/fault-after-initialize") throw new Error("Test lost initialization response");
    return result;
  }
}
