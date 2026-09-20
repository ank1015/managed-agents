import { jsonEquals, parseGatewayEventReply } from "@managed-agents/contracts";
import type { ExecutionGatewayEvent } from "@managed-agents/contracts";
import { receiverBinding } from "./types.ts";
import type { Env } from "./types.ts";

/** No early acknowledgement: gateway retries own recovery until DO admission. */
export class CallbackService {
  constructor(readonly env: Env) {}
  async deliver(event: ExecutionGatewayEvent, signal: AbortSignal): Promise<void> {
    const binding = receiverBinding(this.env, event.clientContext.receiver);
    signal.throwIfAborted();
    const receipt = parseGatewayEventReply(await binding.acceptGatewayEvent(event));
    signal.throwIfAborted();
    if (receipt.eventId !== event.eventId || receipt.jobId !== event.jobId
      || !jsonEquals(receipt.clientContext, event.clientContext)) throw new Error("Callback receiver returned a mismatched receipt.");
  }
}
