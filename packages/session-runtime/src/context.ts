import type { SqlStorage } from "@cloudflare/workers-types";
import { ContractException, parseOperationRequest } from "@managed-agents/contracts";
import type { OperationRequest, SessionInfo } from "@managed-agents/contracts";
import type { HarnessContext } from "@managed-agents/harness-api";
import { insertOperation } from "./storage/operations.ts";
import { copy, freeze, timestamp } from "./values.ts";
import { operationKey } from "./operation-definitions.ts";

export function createContext<Config>(sql: SqlStorage, session: SessionInfo, cause: string | null, operations: ReadonlySet<string>): {
  context: HarnessContext<Config>;
  close(): void;
} {
  let active = true;
  function assertActive(): void {
    if (!active) throw new Error("Harness context has expired.");
  }
  const scopedSql: Pick<SqlStorage, "exec"> = {
    exec(query, ...bindings) {
      assertActive();
      return sql.exec(query, ...bindings);
    },
  };
  const context: HarnessContext<Config> = Object.freeze({
    session: freeze(copy(session.identity)),
    config: freeze(copy(session.config)) as Readonly<Config>,
    sql: Object.freeze(scopedSql),
    requestOperation(request: OperationRequest) {
      assertActive();
      const parsed = parseOperationRequest(request);
      if (!operations.has(operationKey(parsed))) {
        throw new ContractException("INVALID_REQUEST", `Harness has not declared operation ${operationKey(parsed)}.`);
      }
      return insertOperation(sql, session, parsed, cause, timestamp());
    },
  });
  return { context, close() { active = false; } };
}
