/** Only call with already validated JSON or objects constructed from it. */
export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function assertSynchronous(value: unknown, method: string): void {
  // Inspect descriptors rather than invoking getters. A JSON config may legally
  // have a field named `then`; only a callable data property denotes a thenable.
  let thenable = false;
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    let object: object | null = value;
    while (object) {
      const descriptor = Object.getOwnPropertyDescriptor(object, "then");
      if (descriptor) {
        thenable = "value" in descriptor && typeof descriptor.value === "function";
        break;
      }
      object = Object.getPrototypeOf(object) as object | null;
    }
  }
  if (thenable || value instanceof Promise) {
    // A misdeclared async hook can reject after its transaction has rolled back.
    // Observe native promises to avoid an unrelated unhandled-rejection failure.
    // Never invoke an arbitrary thenable. Its work cannot be cancelled here.
    if (value instanceof Promise) void value.catch(() => {});
    throw new Error(`${method} must be synchronous.`);
  }
}

export function assertUndefined(value: unknown, method: string): void {
  assertSynchronous(value, method);
  if (value !== undefined) throw new Error(`${method} must return undefined.`);
}

export function timestamp(): number {
  const value = Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid runtime timestamp.");
  return value;
}
