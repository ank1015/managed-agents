export interface SqlMigration {
  readonly version: number;
  readonly statements: readonly string[];
}

/** Validate trusted migration definitions; application and history belong to the runtime. */
export function validateMigrations(migrations: readonly SqlMigration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous) {
      throw new Error("Migration versions must be positive, strictly increasing safe integers.");
    }
    if (migration.statements.length === 0 || migration.statements.some((sql) => sql.trim().length === 0)) {
      throw new Error(`Migration ${migration.version} must contain nonempty SQL statements.`);
    }
    previous = migration.version;
  }
}
