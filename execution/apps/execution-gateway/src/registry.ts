import { GatewayError } from "@managed-agents/execution-gateway-protocol";
import type { SecretKind } from "@managed-agents/execution-gateway-protocol";
export interface MachineRow extends Record<string, SqlStorageValue> {
  machine_id: string; name: string; deleted: number;
  daemon_hash: string; execution_hash: string; daemon_version: number; execution_version: number;
  connection_epoch: number; created_at: number; last_connected_at: number | null; last_disconnected_at: number | null; daemon: string | null;
}
export class Registry {
  constructor(readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS machine (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), machine_id TEXT NOT NULL, name TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, daemon_hash TEXT NOT NULL, execution_hash TEXT NOT NULL,
      daemon_version INTEGER NOT NULL DEFAULT 1, execution_version INTEGER NOT NULL DEFAULT 1,
      connection_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      last_connected_at INTEGER, last_disconnected_at INTEGER, daemon TEXT)`);
  }
  find(): MachineRow | undefined { return this.storage.sql.exec<MachineRow>("SELECT * FROM machine WHERE singleton = 1").toArray()[0]; }
  get(): MachineRow {
    const row = this.find();
    if (!row) throw new GatewayError(404, "MACHINE_NOT_FOUND", "Machine is not registered.");
    if (row.deleted) throw new GatewayError(410, "MACHINE_DELETED", "Machine has been deleted.");
    return row;
  }
  register(id: string, name: string, daemonHash: string, executionHash: string): { row: MachineRow; duplicate: boolean } {
    const old = this.find();
    if (old) {
      this.get();
      if (old.machine_id !== id || old.name !== name) throw new GatewayError(409, "REGISTRATION_CONFLICT", "Machine ID identifies different registration input.");
      if (old.daemon_version !== 1 || old.execution_version !== 1) throw new GatewayError(409, "REGISTRATION_ROTATED", "Credentials have rotated; recover the rotation response or configure the current daemon secret.");
      if (old.daemon_hash !== daemonHash || old.execution_hash !== executionHash) throw new GatewayError(503, "ISSUANCE_KEY_CHANGED", "Credential issuance key changed; rotate credentials explicitly.");
      return { row: old, duplicate: true };
    }
    this.storage.sql.exec("INSERT INTO machine(singleton, machine_id, name, daemon_hash, execution_hash, created_at) VALUES (1, ?, ?, ?, ?, ?)", id, name, daemonHash, executionHash, Date.now());
    return { row: this.get(), duplicate: false };
  }
  rotate(kind: SecretKind, expected: number, hash: string): { row: MachineRow; changed: boolean } {
    const row = this.get(), version = row[`${kind}_version`];
    if (version === expected + 1) {
      if (row[`${kind}_hash`] !== hash) throw new GatewayError(503, "ISSUANCE_KEY_CHANGED", "Credential issuance key changed.");
      return { row, changed: false };
    }
    if (version !== expected) throw new GatewayError(409, "VERSION_CONFLICT", "Secret version changed.");
    this.storage.sql.exec(`UPDATE machine SET ${kind}_version = ${kind}_version + 1, ${kind}_hash = ? WHERE singleton = 1`, hash);
    return { row: this.get(), changed: true };
  }
  delete(): void {
    if (!this.find()) throw new GatewayError(404, "MACHINE_NOT_FOUND", "Machine is not registered.");
    // Retain a tombstone: a machine ID can never be registered again.
    this.storage.sql.exec("UPDATE machine SET deleted = 1, daemon_hash = '', execution_hash = '' WHERE singleton = 1");
  }
  connected(): MachineRow {
    this.get(); this.storage.sql.exec("UPDATE machine SET connection_epoch = connection_epoch + 1, last_connected_at = ?, last_disconnected_at = NULL WHERE singleton = 1", Date.now());
    return this.get();
  }
  disconnected(epoch: number): void { this.storage.sql.exec("UPDATE machine SET last_disconnected_at = ? WHERE singleton = 1 AND connection_epoch = ?", Date.now(), epoch); }
  metadata(value: string): void { this.storage.sql.exec("UPDATE machine SET daemon = ? WHERE singleton = 1", value); }
}
