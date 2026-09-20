import type { SqlStorage } from "@cloudflare/workers-types";
import type { SessionInfo } from "@managed-agents/contracts";
import type { HarnessInitializationContext, HarnessReadContext } from "@managed-agents/harness-api";
import { operationId } from "./operation-identity.ts";

export function createInitializationContext<Config>(sql: SqlStorage, session: SessionInfo, readOnly = false) {
  let active = true;
  function assertActive(): void { if (!active) throw new Error("Harness context has expired."); }
  const scopedSql: Pick<SqlStorage, "exec"> = {
    exec(query, ...bindings) {
      assertActive();
      // Deliberately small query interface, not a general SQL parser/security boundary.
      if (readOnly && (!/^\s*SELECT\b/i.test(query) || /;\s*\S/.test(query))) {
        throw new Error("Planning allows single SELECT statements only; writes belong in apply().");
      }
      return sql.exec(query, ...bindings);
    },
  };
  const context: HarnessInitializationContext<Config> = Object.freeze({
    session: session.identity, config: session.config as Readonly<Config>, sql: Object.freeze(scopedSql),
  });
  return { context, assertActive, close() { active = false; } };
}
export function createReadContext<Config>(sql: SqlStorage, session: SessionInfo, sequence: number) {
  const scope = createInitializationContext<Config>(sql, session, true);
  const context: HarnessReadContext<Config> = Object.freeze({ ...scope.context,
    operationId(key: string) { scope.assertActive(); return operationId(session.identity, sequence, key); },
  });
  return { context, close: scope.close };
}
