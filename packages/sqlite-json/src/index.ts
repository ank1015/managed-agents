import type { SqlStorage } from "@cloudflare/workers-types";

type Sql = Pick<SqlStorage, "exec">;
const INLINE_BYTES = 256 * 1024;
const CHUNK_CHARS = 64 * 1024;
const PREFIX = "@sqlite-json:1:";
// Internal envelope headroom above the public 8 MiB operation contract.
const MAX_BYTES = 10 * 1024 * 1024;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function tableName(table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error("Invalid chunk table identifier.");
  return table;
}
/** Schema belongs to the caller's versioned migrations, not helper construction. */
export function jsonChunksSchema(table: string): string {
  return `CREATE TABLE ${tableName(table)} (
    payload_id TEXT NOT NULL,
    part INTEGER NOT NULL CHECK (part >= 0),
    content TEXT NOT NULL,
    PRIMARY KEY (payload_id, part)
  )`;
}
function manifest(stored: string) {
  if (!stored.startsWith("@")) return null;
  const match = /^@sqlite-json:1:([a-f0-9-]{36}):(\d+):(\d+)$/.exec(stored);
  if (!match) throw new Error("Invalid chunk manifest.");
  const count = Number(match[2]), bytes = Number(match[3]);
  if (!Number.isSafeInteger(count) || count < 1 || count > Math.ceil(MAX_BYTES / CHUNK_CHARS) + 1
    || !Number.isSafeInteger(bytes) || bytes <= INLINE_BYTES || bytes > MAX_BYTES) throw new Error("Invalid chunk manifest bounds.");
  return { id: match[1]!, count, bytes };
}
export function storedJsonBytes(stored: string): number { return manifest(stored)?.bytes ?? utf8Bytes(stored); }

/** Caller MUST wrap chunk writes and their owning row in the same synchronous transaction.
 * Small values stay ordinary JSON. Large values use a non-JSON manifest, so user JSON
 * can never be confused with a reference. Every reference has exactly one owning field.
 */
export function writeJson(sql: Sql, table: string, value: unknown): string {
  tableName(table);
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Expected JSON-serializable value.");
  const bytes = utf8Bytes(json);
  if (bytes > MAX_BYTES) throw new Error("Stored JSON exceeds internal payload envelope limit.");
  if (bytes <= INLINE_BYTES) return json;
  const id = crypto.randomUUID();
  let part = 0;
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + CHUNK_CHARS, json.length);
    // Never split a surrogate pair: SQL text encoding must round-trip exactly.
    const last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
    sql.exec(`INSERT INTO ${table} (payload_id, part, content) VALUES (?, ?, ?)`, id, part++, json.slice(start, end)).toArray();
    start = end;
  }
  return `${PREFIX}${id}:${part}:${bytes}`;
}
export function readJsonText(sql: Sql, table: string, stored: string): string {
  tableName(table);
  const ref = manifest(stored);
  if (!ref) return stored;
  const parts: string[] = [];
  let bytes = 0;
  for (const row of sql.exec<{ part: number; content: string }>(`SELECT part, content FROM ${table} WHERE payload_id = ? ORDER BY part`, ref.id)) {
    if (row.part !== parts.length || parts.length >= ref.count || row.content.length > CHUNK_CHARS) throw new Error("Corrupt JSON chunks.");
    bytes += utf8Bytes(row.content);
    if (bytes > ref.bytes) throw new Error("Corrupt JSON chunk length.");
    parts.push(row.content);
  }
  if (parts.length !== ref.count || bytes !== ref.bytes) throw new Error("Incomplete JSON chunks.");
  return parts.join("");
}
export function readJson<T>(sql: Sql, table: string, stored: string): T { return JSON.parse(readJsonText(sql, table, stored)) as T; }
/** Delete alongside the owning row, in the same transaction. Never share manifests. */
export function deleteJson(sql: Sql, table: string, stored: string): void {
  tableName(table);
  const ref = manifest(stored);
  if (ref) sql.exec(`DELETE FROM ${table} WHERE payload_id = ?`, ref.id).toArray();
}
