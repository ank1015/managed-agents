import type { SqlMigration } from "@managed-agents/harness-api";
import { validateMigrations } from "@managed-agents/harness-api";
import { MIGRATION_TABLE_SQL, RUNTIME_MIGRATIONS } from "./storage/schema.ts";
import type { RuntimeStorage } from "./types.ts";

type Scope = "runtime" | "harness";

function pending(storage: RuntimeStorage, scope: Scope, definitions: readonly SqlMigration[]): readonly SqlMigration[] {
  const applied = storage.sql.exec<{ version: number; statements_json: string }>(
    "SELECT version, statements_json FROM runtime_migrations WHERE scope = ? ORDER BY version", scope,
  ).toArray();
  for (const [index, row] of applied.entries()) {
    const definition = definitions[index];
    if (!definition || definition.version !== row.version
      || JSON.stringify(definition.statements) !== row.statements_json) {
      throw new Error(`Incompatible ${scope} migration history at version ${row.version}. Applied migrations must remain an unchanged prefix.`);
    }
  }
  return definitions.slice(applied.length);
}

/** Synchronous startup: validate both histories before applying any new migration. */
export function migrate(storage: RuntimeStorage, harnessMigrations: readonly SqlMigration[], verifySession: () => void): void {
  validateMigrations(RUNTIME_MIGRATIONS);
  validateMigrations(harnessMigrations);
  storage.transactionSync(() => { storage.sql.exec(MIGRATION_TABLE_SQL).toArray(); });
  const runtimePending = pending(storage, "runtime", RUNTIME_MIGRATIONS);
  const harnessPending = pending(storage, "harness", harnessMigrations);
  function apply(scope: Scope, migrations: readonly SqlMigration[]): void {
    for (const migration of migrations) {
      storage.transactionSync(() => {
        for (const statement of migration.statements) storage.sql.exec(statement).toArray();
        storage.sql.exec(
          "INSERT INTO runtime_migrations (scope, version, statements_json) VALUES (?, ?, ?)",
          scope, migration.version, JSON.stringify(migration.statements),
        ).toArray();
      });
    }
  }
  apply("runtime", runtimePending);
  verifySession();
  apply("harness", harnessPending);
}
