export class BodyTooLarge extends Error {}
export async function readLimited(body: ReadableStream<Uint8Array> | null, maximum: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!body) return "";
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new BodyTooLarge("Gateway response exceeds transfer limit."); }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
}
