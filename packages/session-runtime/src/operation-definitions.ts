import { parseJsonValue, parseOperationDefinition } from "@managed-agents/contracts";
import type { OperationDefinition } from "@managed-agents/contracts";

export function operationKey(operation: OperationDefinition): string {
  return JSON.stringify([operation.provider, operation.type, operation.version]);
}

/** Snapshot declarations before a harness can mutate them during a transition. */
export function operationDefinitions(value: unknown): OperationDefinition[] {
  const definitions = parseJsonValue(value);
  if (!Array.isArray(definitions)) throw new Error("Harness operations must be an array.");
  const seen = new Set<string>();
  return definitions.map(value => {
    const definition = parseOperationDefinition(value);
    const key = operationKey(definition);
    if (seen.has(key)) throw new Error(`Duplicate harness operation: ${key}`);
    seen.add(key);
    return definition;
  });
}
