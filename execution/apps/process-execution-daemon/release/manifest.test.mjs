import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManifest, platforms } from "./manifest.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "daemon-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const { file } of platforms) writeFileSync(join(directory, file), `binary:${file}`);
  return directory;
}
const base = "https://downloads.acentric.dev/managed-agents/process-execution-daemon/releases/commit/1-1/";

test("updater manifest includes raw executables, exact sizes/hashes and both macOS architectures", t => {
  const { manifest, checksums } = createManifest(fixture(t), base, "0.1.0+git.abc.1.1");
  assert.deepEqual(Object.keys(manifest), ["protocolVersion", "binary", "version", "artifacts"]);
  assert.equal(manifest.protocolVersion, 1);
  assert.equal(manifest.binary, "process-execution-daemon");
  assert.equal(manifest.version, "0.1.0+git.abc.1.1");
  assert.deepEqual(manifest.artifacts.map(({ os, arch }) => `${os}/${arch}`), ["linux/x86_64", "macos/x86_64", "macos/aarch64", "windows/x86_64"]);
  for (const [i, artifact] of manifest.artifacts.entries()) {
    const file = platforms[i].file, bytes = Buffer.from(`binary:${file}`);
    assert.deepEqual(artifact, { os: platforms[i].os, arch: platforms[i].arch, url: base + file,
      sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length });
  }
  assert.equal(checksums.trim().split("\n").length, 3);
  assert.equal(manifest.artifacts[1].url, manifest.artifacts[2].url);
});

test("incomplete releases, empty binaries, unsafe URLs and invalid versions cannot produce a feed", t => {
  const directory = fixture(t);
  for (const invalid of ["http://example.com/", "https://user:secret@example.com/", "https://example.com/path", "https://example.com/?x=1", "https://example.com/#x"]) {
    assert.throws(() => createManifest(directory, invalid, "0.1.0"));
  }
  for (const version of ["", undefined, "next", "0.1.0\n"]) assert.throws(() => createManifest(directory, base, version));
  writeFileSync(join(directory, platforms[0].file), "");
  assert.throws(() => createManifest(directory, base, "0.1.0"), /binary size/);
  rmSync(join(directory, platforms[0].file));
  assert.throws(() => createManifest(directory, base, "0.1.0"), /ENOENT/);
});
