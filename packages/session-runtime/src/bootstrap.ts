import { RUNTIME_SCHEMA } from "./storage/schema.ts";
import type { RuntimeStorage } from "./types.ts";

/** One local existence check on activation; all tables are created atomically once.
 * The namespace pins the schema/code version. There is no upgrade or history scan. */
export function bootstrap(storage: RuntimeStorage, harnessSchema: readonly string[]): void {
  if (storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_session'").toArray().length) return;
  storage.transactionSync(() => {
    for (const statement of [...RUNTIME_SCHEMA, ...harnessSchema]) storage.sql.exec(statement).toArray();
  });
}
