import type { BashInput, BashSubmission } from "@managed-agents/contracts";
import { GatewayError, MAX_HTTP_BYTES, submission, hashJson, jsonValue, object } from "@managed-agents/execution-gateway-protocol";
import { PI_BASH_RECEIVER, BASH_GATEWAY_PREVIEW_BYTES, bashTimeoutMs } from "@managed-agents/contracts";
import type { BashContext } from "./context.ts";
import { readLimited } from "./http.ts";
import { parseExecutionGatewayUrl } from "@managed-agents/contracts";

export { GatewayError };
export class Gateway {
  readonly base: string;
  constructor(gatewayUrl: string, readonly signal: AbortSignal) {
    this.base = parseExecutionGatewayUrl(gatewayUrl);
  }
  async submit(input: BashInput, parsed: BashSubmission, requestId: string, context: BashContext): Promise<void> {
    const body = submission({ requestId, runtimeGeneration: parsed.execution.runtimeGeneration, operation: { operation: "execution.exec", params: execParams(input) }, callback: { receiver: PI_BASH_RECEIVER, context: jsonValue(context) } });
    const encoded = JSON.stringify(body);
    if (new TextEncoder().encode(encoded).byteLength > MAX_HTTP_BYTES) throw new GatewayError(413, "BASH_REQUEST_TOO_LARGE", "Bash request exceeds the gateway transfer limit.");
    const requestHash = await hashJson(jsonValue({ machineId: input.machineId, ...body }));
    this.signal.throwIfAborted();
    const response = await fetch(`${this.base}/v1/machines/${input.machineId}/requests`, { method: "POST", redirect: "manual", signal: this.signal,
      headers: { Authorization: `Bearer ${parsed.execution.token}`, "Content-Type": "application/json" }, body: encoded });
    // After dispatch, invalid response shapes are uncertain transport failures,
    // never local GatewayError(400) rejections: the daemon may have accepted work.
    let r: Record<string, unknown>;
    try { r = object(JSON.parse(await readLimited(response.body, 64 * 1024, this.signal))); }
    catch { throw Error("Invalid gateway response; submission outcome is uncertain."); }
    if (response.status !== 202) {
      let e: Record<string, unknown>;
      try {
        object(r, ["error"]);
        e = object(r.error, ["code", "message", "retryable", "uncertain"]);
        if (typeof e.code !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(e.code)
          || typeof e.message !== "string" || typeof e.retryable !== "boolean" || typeof e.uncertain !== "boolean") throw Error();
      } catch { throw Error("Invalid gateway error; submission outcome is uncertain."); }
      // Do not log gateway messages, which may include submitted data.
      throw new GatewayError(response.status, e.code, `Gateway submission failed (${e.code}).`, e.retryable, e.uncertain);
    }
    try { object(r, ["status", "machineId", "requestId", "requestHash", "runtimeGeneration"]); }
    catch { throw Error("Invalid gateway acceptance; submission outcome is uncertain."); }
    if (r.status !== "accepted" || r.machineId !== input.machineId || r.requestId !== requestId || r.requestHash !== requestHash || r.runtimeGeneration !== parsed.execution.runtimeGeneration) throw Error("Gateway acceptance identity mismatch; submission outcome is uncertain.");
  }
}

export function execParams(input: BashInput) {
  return { cwd: input.cwd, env: {}, tty: false,
    command: { type: "shell", script: input.command, shell: { executable: "bash", kind: "bash" }, login: false },
    completion: { mode: "finished", timeout_ms: input.timeout === undefined ? null : bashTimeoutMs(input.timeout) },
    output: { strategy: "tail", max_bytes: BASH_GATEWAY_PREVIEW_BYTES, retain_full_output: true },
  };
}
