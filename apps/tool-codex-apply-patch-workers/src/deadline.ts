/** One budget for the complete POST/replay or callback path, below the gateway's 10s callback timeout. */
export const REQUEST_BUDGET_MS = 8_000;

export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms = REQUEST_BUDGET_MS): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Execution adapter deadline exceeded.");
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try { return await Promise.race([work(controller.signal), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
