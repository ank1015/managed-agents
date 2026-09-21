import type { Machine } from "./machine.ts";
export interface Env {
  MACHINES: DurableObjectNamespace<Machine>;
  MANAGEMENT_SECRET: string;
  CREDENTIAL_SIGNING_SECRET: string;
  ROUTING_SIGNING_SECRET: string;
  ROUTING_PREVIOUS_SIGNING_SECRET?: string;
  CALLBACK_ROUTES: string;
  MAX_PENDING_SUBMISSIONS?: string;
  MAX_CONCURRENT_DELIVERIES?: string;
  MAX_BUFFERED_BYTES?: string;
  ACCEPT_TIMEOUT_MS?: string;
  CALLBACK_TIMEOUT_MS?: string;
  [key: string]: unknown;
}
