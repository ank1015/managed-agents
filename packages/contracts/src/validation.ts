import { ContractException } from "./errors.ts";
import type { ContractErrorCode } from "./errors.ts";
import type { JsonValue } from "./json.ts";

/** Internal helpers. Call parseJsonValue before inspecting an external value. */
export function record(
  value: JsonValue | undefined,
  allowedKeys: readonly string[],
  path: string,
  code: ContractErrorCode = "INVALID_REQUEST",
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractException(code, `${path} must be an object.`);
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new ContractException(code, `${path} contains unsupported fields.`);
  }
  return value;
}

export function nonemptyString(
  value: JsonValue | undefined,
  path: string,
  code: ContractErrorCode = "INVALID_REQUEST",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContractException(code, `${path} must be a nonempty string.`);
  }
  return value;
}

export function integer(value: JsonValue | undefined, minimum: number, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new ContractException("INVALID_REQUEST", `${path} must be a safe integer >= ${minimum}.`);
  }
  return value;
}
