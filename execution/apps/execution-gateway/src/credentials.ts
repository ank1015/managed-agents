import { constantEqual, GatewayError, machineSecret, sha256 } from "@managed-agents/execution-gateway-protocol";
import type { SecretKind } from "@managed-agents/execution-gateway-protocol";
import type { MachineRow, Registry } from "./registry.ts";

export async function authorize(registry: Registry, id: string, token: string, kind: SecretKind): Promise<MachineRow> {
  const credential = machineSecret(token, kind), hash = await sha256(token);
  // Read after hashing so concurrent rotation/deletion wins.
  const row = registry.get();
  if (credential.machineId !== id || row.machine_id !== id || credential.version !== row[`${kind}_version`]
    || !constantEqual(hash, row[`${kind}_hash`])) throw new GatewayError(401, "INVALID_SECRET", "Machine secret is invalid or revoked.");
  return row;
}
