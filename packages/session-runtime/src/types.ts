import type { DurableObjectStorage } from "@cloudflare/workers-types";

/** Cloudflare's native SQLite storage capabilities, not a portable database adapter. */
export type RuntimeStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

export type ProcessNextResult =
  | { processed: false }
  | { processed: true; eventId: string; sequence: number };
