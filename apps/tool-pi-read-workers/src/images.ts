import { Buffer } from "node:buffer";
import { decode as decodeBmp } from "bmp-ts";
import { encode as encodePng } from "fast-png";
import type { ReadResult } from "@managed-agents/contracts";
import { sha256 } from "./crypto.ts";
import { readLimited } from "./http.ts";
import { fileDetails, object, readError } from "./result.ts";
import type { ReadFile } from "./result.ts";
import type { ReadContext } from "./context.ts";
import type { Env } from "./types.ts";

export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp";
/** Match Pi's magic-byte detection instead of trusting a file extension. SVG remains text. */
export function detectImageMimeType(bytes: Uint8Array): ImageMime | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] !== 0xf7) return "image/jpeg";
  if (b.length >= 16 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && b.readUInt32BE(8) === 13 && b.toString("ascii", 12, 16) === "IHDR") {
    // Pi leaves animated PNGs on the text path; inspect the same small header window.
    const max = Math.min(b.length, 4100);
    for (let pos = 8; pos + 8 <= max;) {
      const type = b.toString("ascii", pos + 4, pos + 8);
      if (type === "acTL") return null;
      if (type === "IDAT") break;
      const next = pos + b.readUInt32BE(pos) + 12;
      if (next > max) break;
      pos = next;
    }
    return "image/png";
  }
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 26 && b.toString("ascii", 0, 2) === "BM") return "image/bmp";
  return null;
}

/** BMP is accepted by Pi but not Images storage. Bound allocation before decoding it to PNG. */
export function bmpToPng(bytes: Uint8Array): Uint8Array {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 54) throw new Error("Invalid BMP header.");
  const header = b.readUInt32LE(14), width = b.readUInt32LE(18), height = Math.abs(b.readInt32LE(22));
  const bits = b.readUInt16LE(28), colors = b.readUInt32LE(46), offset = b.readUInt32LE(10);
  if (![40, 52, 56, 108, 124].includes(header) || b.length < 14 + header || b.readUInt16LE(26) !== 1
    || !width || !height || width * height > 4_000_000 || ![1, 4, 8, 16, 24, 32].includes(bits)
    || colors > (bits <= 8 ? 2 ** bits : 256) || offset < 14 + header || offset >= b.length) {
    throw new Error("Unsupported BMP header or image exceeds the 4 megapixel decode limit.");
  }
  // The decoder's palette/RLE paths use ABGR even with toRGBA enabled.
  const decoded = decodeBmp(b);
  const hasAlpha = (bits === 16 || bits === 32) && (header >= 56 || b.readUInt32LE(30) === 6)
    && b.readUInt32LE(66) !== 0;
  for (let i = 0; i < decoded.data.length; i += 4) {
    const alpha = decoded.data[i]!, blue = decoded.data[i + 1]!, green = decoded.data[i + 2]!, red = decoded.data[i + 3]!;
    decoded.data[i] = red; decoded.data[i + 1] = green; decoded.data[i + 2] = blue;
    decoded.data[i + 3] = hasAlpha ? alpha : 255;
  }
  const png = encodePng({ width: decoded.width, height: decoded.height, data: decoded.data, depth: 8, channels: 4 });
  if (png.length > 10 * 1024 * 1024) throw new Error("Converted BMP exceeds the image upload limit.");
  return png;
}

type ImageIdentity = { source: "tool-pi-read-v1"; sha256: string; uploadSha256: string };
type ApiReply = { status: number; body: Record<string, unknown> };
class ImageRejected extends Error {}

class Images {
  readonly base: string;
  readonly variant: string;
  readonly token: string;
  readonly signal: AbortSignal;
  constructor(env: Env, signal: AbortSignal) {
    if (!env.CLOUDFLARE_IMAGES_ACCOUNT_ID || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_IMAGES_ACCOUNT_ID)
      || !env.CLOUDFLARE_IMAGES_API_TOKEN?.trim()
      || !env.CLOUDFLARE_IMAGES_VARIANT || !/^[a-zA-Z0-9_-]{1,99}$/.test(env.CLOUDFLARE_IMAGES_VARIANT)) {
      throw new Error("Cloudflare Images account, API token and variant must be configured for image reads.");
    }
    this.base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_IMAGES_ACCOUNT_ID}/images/v1`;
    this.variant = env.CLOUDFLARE_IMAGES_VARIANT;
    this.token = env.CLOUDFLARE_IMAGES_API_TOKEN;
    this.signal = signal;
  }
  async request(path: string, form?: FormData): Promise<ApiReply> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 7000);
    const signal = AbortSignal.any([this.signal, controller.signal]);
    try {
      signal.throwIfAborted();
      const response = await fetch(this.base + path, { method: form ? "POST" : "GET", redirect: "manual", signal,
        headers: { Authorization: `Bearer ${this.token}` }, ...(form ? { body: form } : {}) });
      const body = object(JSON.parse(await readLimited(response.body, 64 * 1024, signal)));
      if (typeof body.success !== "boolean" || !Array.isArray(body.errors)) throw new Error("Malformed Cloudflare Images response.");
      return { status: response.status, body };
    } finally { clearTimeout(timer); }
  }
  uploaded(reply: ApiReply, id: string, expected: ImageIdentity): string {
    if (reply.status < 200 || reply.status >= 300 || reply.body.success !== true) throw new Error(`Cloudflare Images request failed (${reply.status}).`);
    const image = object(reply.body.result), meta = object(image.meta);
    if (image.id !== id || image.requireSignedURLs !== false
      || meta.source !== expected.source || meta.sha256 !== expected.sha256 || meta.uploadSha256 !== expected.uploadSha256
      || !Array.isArray(image.variants)) throw new Error("Cloudflare image identity/metadata does not match this read.");
    for (const candidate of image.variants) {
      if (typeof candidate !== "string" || candidate.length > 4096) continue;
      const url = new URL(candidate);
      const parts = url.pathname.split("/");
      if (url.protocol === "https:" && url.hostname === "imagedelivery.net" && !url.port && !url.username && !url.password
        && !url.search && !url.hash && parts.length === 4 && parts[1]
        && parts[2] === id && parts[3] === this.variant) return candidate;
    }
    throw new Error("Configured Cloudflare Images variant is missing from image delivery URLs.");
  }
  async existing(id: string, expected: ImageIdentity): Promise<string | undefined> {
    const reply = await this.request(`/${encodeURIComponent(id)}`);
    if (reply.status === 404 && reply.body.success === false) return;
    return this.uploaded(reply, id, expected);
  }
  async upload(id: string, bytes: Uint8Array, mimeType: string, expected: ImageIdentity): Promise<string> {
    const existing = await this.existing(id, expected);
    if (existing) return existing;
    const form = new FormData();
    form.append("id", id);
    form.append("requireSignedURLs", "false");
    form.append("metadata", JSON.stringify(expected));
    form.append("file", new File([new Uint8Array(bytes)], `read.${mimeType.slice(6)}`, { type: mimeType }));
    let reply: ApiReply;
    try { reply = await this.request("", form); }
    catch (error) {
      // Upload may have succeeded before its response was lost. Recover the same object.
      this.signal.throwIfAborted();
      const recovered = await this.existing(id, expected);
      if (recovered) return recovered;
      throw error;
    }
    if (reply.status >= 200 && reply.status < 300 && reply.body.success === true) return this.uploaded(reply, id, expected);
    // Includes concurrent creation and any uncertain server-side upload error.
    const recovered = await this.existing(id, expected);
    if (recovered) return recovered;
    if ([413, 415, 422].includes(reply.status) && reply.body.success === false
      && Array.isArray(reply.body.errors) && reply.body.errors.length > 0) {
      throw new ImageRejected("The image could not be uploaded: Cloudflare Images rejected its format, dimensions or contents.");
    }
    throw new Error(`Cloudflare Images upload unavailable (${reply.status}).`);
  }
}

export async function formatImage(file: ReadFile, originalMimeType: ImageMime, jobId: string, context: ReadContext,
  env: Env, signal: AbortSignal): Promise<ReadResult> {
  let bytes = file.bytes, mimeType: string = originalMimeType;
  if (originalMimeType === "image/bmp") {
    try { bytes = bmpToPng(bytes); mimeType = "image/png"; }
    catch { return readError(jobId, context, "READ_IMAGE_INVALID", "BMP could not be converted to PNG. Supported BMP images must have a valid Windows bitmap header and at most 4 megapixels."); }
  }
  signal.throwIfAborted();
  const id = `pi-read-v1-${await sha256(JSON.stringify([context.operationId, jobId, file.sha256]))}`;
  const uploadSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
  let url: string;
  try { url = await new Images(env, signal).upload(id, bytes, mimeType, { source: "tool-pi-read-v1", sha256: file.sha256, uploadSha256 }); }
  catch (error) {
    if (error instanceof ImageRejected) return readError(jobId, context, "READ_IMAGE_REJECTED", error.message);
    throw error;
  }
  return { content: [{ type: "text", text: `Read image file [${mimeType}]${originalMimeType === "image/bmp" ? "\n[Image converted from image/bmp to image/png.]" : ""}` },
      { type: "image", url }], isError: false,
    details: { ...fileDetails(file, jobId, context), image: { id, url, mimeType, originalMimeType } } };
}
