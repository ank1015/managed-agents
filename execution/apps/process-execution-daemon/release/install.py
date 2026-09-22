#!/usr/bin/env python3
"""Install a verified daemon release using only Python 3's standard library."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlsplit

DEFAULT_MANIFEST = "https://downloads.acentric.dev/managed-agents/process-execution-daemon/latest/manifest.json"
MAX_BINARY = 256 * 1024 * 1024


def secure_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.fragment or any(ord(c) < 32 for c in value)):
        raise ValueError("Release URLs must use HTTPS without credentials or fragments")
    return value


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Release downloads must not redirect")


def download(url, maximum):
    request = urllib.request.Request(secure_url(url), headers={"User-Agent": "process-execution-daemon-installer/1"})
    for attempt in range(3):
        try:
            with urllib.request.build_opener(NoRedirects).open(request, timeout=20) as response:
                data = response.read(maximum + 1)
                if len(data) > maximum:
                    raise ValueError("Release download exceeds its size limit")
                return data
        except (OSError, urllib.error.URLError, http.client.IncompleteRead) as error:
            retryable = not isinstance(error, urllib.error.HTTPError) or error.code == 429 or error.code >= 500
            if not retryable or attempt == 2:
                raise
            print("Download interrupted; retrying ({}/3).".format(attempt + 2), file=sys.stderr)
            time.sleep(attempt + 1)


def host():
    system = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(platform.system())
    arch = {"x86_64": "x86_64", "AMD64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(platform.machine())
    if not system or not arch:
        raise ValueError("Unsupported OS or architecture")
    return system, arch


def artifact(manifest, system, arch):
    if (manifest.get("protocolVersion") != 1 or manifest.get("binary") != "process-execution-daemon"
            or not isinstance(manifest.get("version"), str) or not manifest["version"]):
        raise ValueError("Manifest is not for this daemon/protocol")
    selected = next((a for a in manifest["artifacts"] if a["os"] == system and a["arch"] == arch), None)
    if selected is None:
        raise ValueError("Release has no binary for this OS/architecture")
    secure_url(selected["url"])
    if (type(selected.get("sizeBytes")) is not int or not 0 < selected["sizeBytes"] <= MAX_BINARY
            or not isinstance(selected.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", selected["sha256"])):
        raise ValueError("Invalid artifact size or SHA-256")
    return selected


def verify(data, selected):
    if len(data) != selected["sizeBytes"] or hashlib.sha256(data).hexdigest() != selected["sha256"]:
        raise ValueError("Binary size/checksum mismatch; installation was not changed")


def identity(path):
    result = subprocess.run([str(path), "--version"], capture_output=True, timeout=10, check=True)
    if not result.stdout.startswith(b"process-execution-daemon "):
        raise ValueError("Executable is not a compatible daemon")


def install(manifest_url, bin_dir):
    system, arch = host()
    manifest_url = secure_url(manifest_url)
    manifest = json.loads(download(manifest_url, 1024 * 1024))
    selected = artifact(manifest, system, arch)
    target = bin_dir / ("process-execution-daemon.exe" if system == "windows" else "process-execution-daemon")
    if target.is_symlink():
        raise ValueError("Refusing to replace a symlink; use a regular installation path")
    if target.exists():
        identity(target)
        # The daemon updater owns safe stop/replacement/restart on every platform.
        subprocess.run([str(target), "update", "--manifest-url", manifest_url], check=True)
        return target
    print("Downloading and verifying {} / {} release...".format(system, arch), flush=True)
    data = download(selected["url"], selected["sizeBytes"])
    verify(data, selected)
    notices = {name: download(urljoin(selected["url"], name), 128 * 1024) for name in ["NOTICE", "CODEX-LICENSE"]}
    bin_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".execution-install-", dir=bin_dir) as temporary:
        staged = Path(temporary) / target.name
        with staged.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        staged.chmod(0o755)
        identity(staged)
        if target.exists() or target.is_symlink():
            raise ValueError("Installation appeared concurrently; rerun the installer")
        # A hard link atomically creates the final name without overwriting a
        # concurrently installed binary. Both paths are on the same filesystem.
        os.link(staged, target)
        notice_dir = bin_dir.parent / "share" / "process-execution-daemon"
        notice_dir.mkdir(parents=True, exist_ok=True)
        for name, contents in notices.items():
            (notice_dir / name).write_bytes(contents)
    print("Installed {} to {}".format(manifest["version"], target))
    return target


def main():
    default_bin = (Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "managed-agents" / "bin"
                   if os.name == "nt" else Path.home() / ".local" / "bin")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, default=default_bin)
    parser.add_argument("--manifest-url", default=DEFAULT_MANIFEST)
    args = parser.parse_args()
    target = install(args.manifest_url, args.bin_dir.expanduser().absolute())
    print("Add {} to PATH if needed.".format(target.parent))
    print("Next: process-execution-daemon register --url https://YOUR-APP/api/machines/enroll")
    print("Then: process-execution-daemon connect")
    print("Later updates: process-execution-daemon update")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, http.client.HTTPException, subprocess.SubprocessError) as error:
        print("Installation failed: {}".format(error), file=sys.stderr)
        sys.exit(1)
