import { ContractException } from "./errors.ts";
import type { ContractErrorCode } from "./errors.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Validate without coercing, cloning, or invoking getters/toJSON methods. */
export function parseJsonValue(
  value: unknown,
  code: ContractErrorCode = "INVALID_REQUEST",
): JsonValue {
  const ancestors = new Set<object>();

  function visit(current: unknown): asserts current is JsonValue {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (typeof current !== "object" || current === null) {
      throw new ContractException(code, "Expected a JSON-compatible value.");
    }

    const array = Array.isArray(current);
    const prototype: unknown = Object.getPrototypeOf(current);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      throw new ContractException(code, "JSON values must use plain objects or arrays.");
    }
    if (ancestors.has(current)) {
      throw new ContractException(code, "JSON values must not contain cycles.");
    }

    ancestors.add(current);
    const keys = Reflect.ownKeys(current);
    if (array && keys.length !== current.length + 1) {
      throw new ContractException(code, "JSON arrays must be dense and have no extra properties.");
    }

    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      ) {
        throw new ContractException(code, "JSON properties must be enumerable string-keyed data properties.");
      }
      if (array) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= current.length || String(index) !== key) {
          throw new ContractException(code, "JSON arrays must not have extra properties.");
        }
      }
      visit(descriptor.value);
    }
    ancestors.delete(current);
  }

  visit(value);
  return value;
}

/** Structural equality for validated JSON; object key order is not significant. */
export function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left)) {
    return Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEquals(value, right[index]!));
  }
  if (Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key]!, right[key]!));
}
