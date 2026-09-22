import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { decode as decodePng } from "fast-png";
import { decodeFile, formatText, truncateHead } from "../src/result.ts";
import type { ReadFile } from "../src/result.ts";
import { detectImageMimeType, bmpToPng } from "../src/images.ts";
import type { ReadContext } from "../src/context.ts";

const context: ReadContext = { gatewayUrl: "https://gateway.test", routeKey: "test-v1", sessionId: "session", runtimeGeneration: "00000000-0000-4000-8000-000000000002", cwd: "/workspace", operationId: "o", submissionId: "o",
  machineId: "00000000-0000-4000-8000-000000000001", path: "file.txt", offset: null, limit: null };
function file(text: string): ReadFile {
  return { bytes: Buffer.from(text), path: "/workspace/file.txt", sha256: createHash("sha256").update(text).digest("hex"), modifiedAt: null, isSymlink: false };
}
function format(text: string, args: Partial<Pick<ReadContext, "offset" | "limit">> = {}) { return formatText(file(text), "job", { ...context, ...args }); }
function text(result: ReturnType<typeof format>) {
  const part = result.content[0]; assert.equal(part?.type, "text");
  return part.type === "text" ? part.text : "";
}
export function bmp() {
  const b = Buffer.alloc(58);
  b.write("BM"); b.writeUInt32LE(58, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeUInt32LE(1, 18); b.writeUInt32LE(1, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(4, 34); b[56] = 255;
  return b;
}
test("Pi read preserves empty content, final newlines, CRLF, Unicode and BOM", () => {
  for (const value of ["", "hello", "hello\n", "\n", "a\n\n", "a\r\nb\r\n", "😀é\n", "\uFEFFhello"]) {
    const result = format(value); assert.equal(text(result), value); assert.equal(result.isError, false);
    assert.equal(result.details.truncation, undefined);
  }
  assert.equal(text(format("a\nb\n", { offset: 3 })), "");
  assert.match(text(format("a\nb", { offset: 3 })), /Offset 3 is beyond end of file \(2 lines total\)/);
  assert.equal(format("a\nb", { offset: 3 }).isError, true);
});
test("one-based paging returns complete lines and actionable continuation", () => {
  const value = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");
  assert.equal(text(format(value, { offset: 41, limit: 20 })), Array.from({ length: 20 }, (_, i) => `Line ${i + 41}`).join("\n") + "\n\n[40 more lines in file. Use offset=61 to continue.]");
  assert.equal(text(format(value, { offset: 100, limit: Number.MAX_SAFE_INTEGER })), "Line 100");
  const large = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`).join("\n");
  const result = format(large);
  assert.match(text(result), /Line 2000\n\n\[Showing lines 1-2000 of 2500. Use offset=2001 to continue.\]$/);
  assert.equal(result.details.truncation?.truncatedBy, "lines");
  assert.equal(result.details.truncation?.outputLines, 2000);
});
test("50 KiB cap never cuts a line or Unicode character; overlong first line gets a fallback", () => {
  const value = ("😀".repeat(150) + "\n").repeat(400);
  const result = format(value), t = result.details.truncation!;
  assert.equal(t.truncatedBy, "bytes"); assert.ok(t.outputBytes <= 51200);
  assert.equal(t.outputBytes, Buffer.byteLength(t.content)); assert.equal(t.lastLinePartial, false);
  assert.ok(!t.content.includes("�")); assert.match(text(result), /Use offset=\d+ to continue/);
  const long = format("x".repeat(51201));
  assert.equal(long.details.truncation?.firstLineExceedsLimit, true);
  assert.match(text(long), /Line 1 is 50.0KB, exceeds 50.0KB limit/);
  assert.equal(truncateHead("x".repeat(51200)).truncated, false);
});
test("raw file results enforce base64, digest, metadata and the inclusive 5 MiB limit", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 120);
  const value = { type: "bytes", file: { path: "/file", size_bytes: bytes.length, is_symlink: false, modified_at: null,
    sha256: createHash("sha256").update(bytes).digest("hex") }, data_base64: bytes.toString("base64") };
  const decoded = await decodeFile(value); assert.notEqual(decoded, "too_large");
  assert.equal(decoded === "too_large" ? 0 : decoded.bytes.length, bytes.length);
  assert.equal(await decodeFile({ ...value, file: { ...value.file, size_bytes: bytes.length + 1 } }), "too_large");
  for (const patch of [{ file: { ...value.file, sha256: "0".repeat(64) } }, { data_base64: "AA=A" }, { data_base64: "eA" },
    { file: { ...value.file, path: "relative" } }, { type: "text" }, { file: { ...value.file, modified_at: "bad" } }]) {
    await assert.rejects(decodeFile({ ...value, ...patch }));
  }
});
test("image detection uses magic bytes and BMP conversion preserves pixel colors", () => {
  assert.equal(detectImageMimeType(Buffer.from("not an image.png")), null);
  assert.equal(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectImageMimeType(Buffer.from("GIF89a")), "image/gif");
  assert.equal(detectImageMimeType(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(detectImageMimeType(bmp()), "image/bmp");
  const png = bmpToPng(bmp()), decoded = decodePng(png);
  assert.equal(detectImageMimeType(png), "image/png");
  assert.deepEqual(Array.from(decoded.data), [255, 0, 0, 255]);
  // Palette decoding and alpha bitfields exercise the decoder's other channel layouts.
  const indexed = Buffer.alloc(62); bmp().copy(indexed);
  indexed.writeUInt32LE(62, 2); indexed.writeUInt32LE(58, 10); indexed.writeUInt16LE(8, 28);
  indexed.writeUInt32LE(1, 46); indexed[58] = 0;
  assert.deepEqual(Array.from(decodePng(bmpToPng(indexed)).data), [255, 0, 0, 255]);
  const rgba = Buffer.alloc(74); bmp().copy(rgba);
  rgba.writeUInt32LE(74, 2); rgba.writeUInt32LE(70, 10); rgba.writeUInt32LE(56, 14); rgba.writeUInt16LE(32, 28);
  rgba.writeUInt32LE(3, 30); rgba.writeUInt32LE(0x00ff0000, 54); rgba.writeUInt32LE(0x0000ff00, 58);
  rgba.writeUInt32LE(0x000000ff, 62); rgba.writeUInt32LE(0xff000000, 66); rgba.writeUInt32LE(0x80ff0000, 70);
  assert.deepEqual(Array.from(decodePng(bmpToPng(rgba)).data), [255, 0, 0, 128]);
  const huge = bmp(); huge.writeUInt32LE(10000, 18); huge.writeUInt32LE(10000, 22);
  assert.throws(() => bmpToPng(huge), /decode limit/);
  const palette = bmp(); palette.writeUInt32LE(0xffffffff, 46);
  assert.throws(() => bmpToPng(palette));
});
