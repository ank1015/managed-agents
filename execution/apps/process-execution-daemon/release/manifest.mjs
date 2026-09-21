import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const platforms = [
  { os: "linux", arch: "x86_64", file: "process-execution-daemon-linux-x86_64" },
  { os: "macos", arch: "x86_64", file: "process-execution-daemon-macos-universal" },
  { os: "macos", arch: "aarch64", file: "process-execution-daemon-macos-universal" },
  { os: "windows", arch: "x86_64", file: "process-execution-daemon-windows-x86_64.exe" },
];

/** Matches the strict raw-executable manifest in src/update.rs (not the old archive feed). */
export function createManifest(directory, base, version) {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/")) {
    throw Error("Release base must be an HTTPS directory URL without credentials, query or fragment");
  }
  if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) {
    throw Error("Invalid release version");
  }
  const files = new Map();
  for (const { file } of platforms) {
    if (files.has(file)) continue;
    const bytes = readFileSync(join(directory, file));
    if (!bytes.length || bytes.length > 256 * 1024 * 1024) throw Error(`Invalid binary size: ${file}`);
    files.set(file, { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length });
  }
  return {
    manifest: {
      protocolVersion: 1,
      binary: "process-execution-daemon",
      version,
      artifacts: platforms.map(({ os, arch, file }) => ({ os, arch, url: new URL(file, url).href, ...files.get(file) })),
    },
    checksums: [...files].map(([file, { sha256 }]) => `${sha256}  ${file}\n`).join(""),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, base, version, ...extra] = process.argv.slice(2);
  if (!directory || !base || !version || extra.length) throw Error("Usage: node manifest.mjs DIRECTORY BASE_URL VERSION");
  const { manifest, checksums } = createManifest(directory, base, version);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(directory, "checksums.sha256"), checksums);
}
