import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import install


class InstallerTests(unittest.TestCase):
    def test_download_retries_transient_failures_but_not_authorization_errors(self):
        opener = MagicMock()
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"bytes"
        opener.open.side_effect = [TimeoutError("TLS handshake timeout"), response]
        with patch.object(install.urllib.request, "build_opener", return_value=opener), patch.object(install.time, "sleep"):
            self.assertEqual(install.download("https://downloads.example/file", 8), b"bytes")
            self.assertEqual(opener.open.call_count, 2)
            opener.open.reset_mock()
            opener.open.side_effect = install.urllib.error.HTTPError("https://downloads.example/file", 403, "Forbidden", {}, None)
            with self.assertRaises(install.urllib.error.HTTPError): install.download("https://downloads.example/file", 8)
            self.assertEqual(opener.open.call_count, 1)

    def fixture(self):
        data = b"verified test executable"
        artifact = {"os": "macos", "arch": "aarch64", "url": "https://downloads.example/releases/test/daemon",
                    "sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        manifest = {"protocolVersion": 1, "binary": "process-execution-daemon", "version": "0.1.0+test", "artifacts": [artifact]}
        return data, artifact, manifest

    def test_validates_manifest_platform_size_hash_and_transport(self):
        data, artifact, manifest = self.fixture()
        self.assertEqual(install.artifact(manifest, "macos", "aarch64"), artifact)
        install.verify(data, artifact)
        with self.assertRaises(ValueError): install.verify(b"wrong", artifact)
        with self.assertRaises(ValueError): install.artifact(manifest, "linux", "aarch64")
        for url in ["http://downloads.example/a", "https://user:secret@example/a", "file:///tmp/a", "https://example/a#fragment"]:
            with self.assertRaises(ValueError): install.secure_url(url)
        for size in [0, -1, True, install.MAX_BINARY + 1]:
            artifact["sizeBytes"] = size
            with self.assertRaises(ValueError): install.artifact(manifest, "macos", "aarch64")
        with self.assertRaises(ValueError):
            install.NoRedirects().redirect_request(None, None, 302, None, None, "https://elsewhere.example")

    def test_install_and_repeat_use_safe_updater_without_touching_state(self):
        data, _, manifest = self.fixture()
        def fetch(url, maximum):
            if url.endswith("manifest.json"): return json.dumps(manifest).encode()
            if url.endswith("daemon"): return data
            return b"license notice"
        with tempfile.TemporaryDirectory() as directory, patch.object(install, "host", return_value=("macos", "aarch64")), \
                patch.object(install, "download", side_effect=fetch), patch.object(install, "identity") as identity, \
                patch.object(install.subprocess, "run") as run:
            bin_dir = Path(directory) / "bin"
            target = install.install(install.DEFAULT_MANIFEST, bin_dir)
            self.assertEqual(target.read_bytes(), data)
            identity.assert_called_once()
            self.assertTrue((Path(directory) / "share/process-execution-daemon/NOTICE").exists())
            run.assert_not_called()
            install.install(install.DEFAULT_MANIFEST, bin_dir)
            run.assert_called_once_with([str(target), "update", "--manifest-url", install.DEFAULT_MANIFEST], check=True)
            self.assertEqual(target.read_bytes(), data)

    def test_bad_checksum_does_not_create_installation(self):
        _, _, manifest = self.fixture()
        with tempfile.TemporaryDirectory() as directory, patch.object(install, "host", return_value=("macos", "aarch64")), \
                patch.object(install, "download", side_effect=[json.dumps(manifest).encode(), b"bad"]):
            target = Path(directory) / "bin"
            with self.assertRaises(ValueError): install.install(install.DEFAULT_MANIFEST, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
