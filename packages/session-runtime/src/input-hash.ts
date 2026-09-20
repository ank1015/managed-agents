import { sha256 } from "@noble/hashes/sha2.js";
import type { EventBody, JsonValue } from "@managed-agents/contracts";

/** Only accepts validated JSON. Canonical object ordering preserves structural
 * retry equality; arrays remain ordered. Synchronous hashing keeps admission and
 * completion storage transactions synchronous on both workerd and Node. */
export function inputHash(event: EventBody): string {
  const hash = sha256.create();
  const encoder = new TextEncoder();
  const write = (text: string) => { hash.update(encoder.encode(text)); };
  function visit(value: JsonValue): void {
    if (value === null || typeof value !== "object") { write(JSON.stringify(value)); return; }
    if (Array.isArray(value)) {
      write("[");
      value.forEach((item, index) => { if (index) write(","); visit(item); });
      write("]");
    } else {
      write("{");
      Object.keys(value).sort().forEach((key, index) => {
        if (index) write(",");
        write(JSON.stringify(key)); write(":"); visit(value[key]!);
      });
      write("}");
    }
  }
  visit({ type: event.type, payload: event.payload });
  return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, "0")).join("");
}
