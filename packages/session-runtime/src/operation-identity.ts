import { ContractException } from "@managed-agents/contracts";
import type { SessionIdentity } from "@managed-agents/contracts";
import { sha256 } from "@noble/hashes/sha2.js";

export function operationId(session: SessionIdentity, sequence: number, key: string): string {
  if (typeof key !== "string" || !key || key.length > 2048) throw new Error("Operation keys must contain 1–2048 characters.");
  const digest = sha256(new TextEncoder().encode(JSON.stringify([session.sessionId, session.harness.id, session.harness.version, sequence, key])));
  return `replay-v1:${sequence}:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
/** Self-describing correlation validates early callbacks without an operation journal. */
export function operationIdentity(id: string): { sequence: number } {
  try {
    const match = /^replay-v1:([1-9][0-9]*):[a-f0-9]{64}$/.exec(id), sequence = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(sequence)) throw new Error();
    return { sequence };
  } catch { throw new ContractException("COMPLETION_CONFLICT", "Operation does not belong to this session/namespace."); }
}
