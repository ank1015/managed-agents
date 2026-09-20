import type { LogSettings } from "@managed-agents/diagnostics";
import type { GatewayEventReceiverBinding } from "@managed-agents/contracts";

export interface Env extends LogSettings {
  EXECUTION_GATEWAY_WEBHOOK_SECRET: string;
  EXECUTION_GATEWAY_PREVIOUS_WEBHOOK_SECRET?: string;
  CALLBACK_ROUTES: string;
  [binding: string]: unknown;
}
export function receiverBinding(env: Env, receiver: string): GatewayEventReceiverBinding {
  const routes: unknown = JSON.parse(env.CALLBACK_ROUTES);
  if (!routes || typeof routes !== "object" || Array.isArray(routes) || !Object.hasOwn(routes, receiver)) {
    throw new Error("Callback receiver is not configured.");
  }
  const name: unknown = (routes as Record<string, unknown>)[receiver];
  const binding = typeof name === "string" && Object.hasOwn(env, name) ? env[name] as GatewayEventReceiverBinding | undefined : undefined;
  if (!binding || typeof binding.acceptGatewayEvent !== "function") throw new Error("Callback service binding is not configured.");
  return binding;
}
