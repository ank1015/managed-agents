use crate::{Result, http, service::Service, store};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path, time::Duration};
use url::Url;
pub const DEFAULT_MANIFEST_URL: &str =
    "https://downloads.acentric.dev/managed-agents/process-execution-daemon/latest/manifest.json";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    protocol_version: u8,
    binary: String,
    version: String,
    artifacts: Vec<Artifact>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Artifact {
    os: String,
    arch: String,
    url: String,
    sha256: String,
    size_bytes: usize,
}
const MAX_BINARY: usize = 256 * 1024 * 1024;
fn secure_url(s: &str) -> Result<Url> {
    let u = Url::parse(s)?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err("update URLs must use HTTPS without embedded credentials".into());
    }
    Ok(u)
}
fn checksum(data: &[u8], expected: &str) -> Result<()> {
    if !crate::protocol::digest(expected) || format!("{:x}", Sha256::digest(data)) != expected {
        return Err("update checksum did not match; installed binary was not changed".into());
    }
    Ok(())
}
pub async fn apply(
    directory: &Path,
    manifest: Option<&str>,
    from: Option<&Path>,
    sha: Option<&str>,
) -> Result<()> {
    let current = std::env::current_exe()?.canonicalize()?;
    let (bytes, version) = if let Some(path) = from {
        if std::fs::metadata(path)?.len() > MAX_BINARY as u64 {
            return Err("update binary exceeds limit".into());
        }
        let bytes = std::fs::read(path)?;
        checksum(&bytes, sha.ok_or("--from requires --sha256")?)?;
        (bytes, "local build".to_string())
    } else {
        let client = http::client()?;
        let response = client
            .get(secure_url(
                manifest.ok_or("provide --manifest-url or --from with --sha256")?,
            )?)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err("release manifest download failed".into());
        }
        let value: Manifest = serde_json::from_slice(&http::limited(response, 1024 * 1024).await?)?;
        if value.binary != "process-execution-daemon"
            || value.protocol_version != 1
            || value.version.is_empty()
        {
            return Err("release manifest is not for this daemon/protocol".into());
        }
        let artifact = value
            .artifacts
            .iter()
            .find(|a| a.os == std::env::consts::OS && a.arch == std::env::consts::ARCH)
            .ok_or("release has no binary for this OS and architecture")?;
        if artifact.size_bytes == 0 || artifact.size_bytes > MAX_BINARY {
            return Err("release size exceeds limit".into());
        }
        let response = client.get(secure_url(&artifact.url)?).send().await?;
        if !response.status().is_success() {
            return Err("release binary download failed".into());
        }
        let bytes = http::limited(response, artifact.size_bytes).await?;
        if bytes.len() != artifact.size_bytes {
            return Err("release binary size did not match manifest".into());
        }
        checksum(&bytes, &artifact.sha256)?;
        (bytes, value.version)
    };
    let parent = current.parent().ok_or("binary has no parent directory")?;
    let temp = tempfile::Builder::new()
        .prefix(".execution-update-")
        .tempdir_in(parent)?;
    let replacement = temp
        .path()
        .join(current.file_name().ok_or("binary has no filename")?);
    let mut file = std::fs::File::create(&replacement)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o755))?;
    }
    // Check the CLI identity before stopping a working installation. --version is side-effect free.
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(&replacement)
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    if !output.status.success()
        || !String::from_utf8_lossy(&output.stdout).starts_with("process-execution-daemon ")
    {
        return Err("replacement is not a compatible daemon executable".into());
    }
    let restart = store::running(directory)?;
    let service = Service::new(directory.to_owned(), None)?;
    if restart {
        crate::stop(directory).await?;
        service.disconnect()?;
    }
    #[cfg(unix)]
    {
        let backup = temp.path().join("previous");
        std::fs::copy(&current, &backup)?;
        if let Err(e) = std::fs::rename(&replacement, &current) {
            if restart {
                let _ = service.connect();
            }
            return Err(e.into());
        }
        std::fs::File::open(parent)?.sync_all()?;
        if restart && let Err(e) = service.connect() {
            std::fs::rename(&backup, &current)?;
            let _ = service.connect();
            return Err(format!("service restart failed; previous binary restored: {e}").into());
        }
        println!(
            "Updated to {version}.{}",
            if restart {
                " Daemon restarted."
            } else {
                " Run `connect` to start."
            }
        );
    }
    #[cfg(windows)]
    {
        let temp = temp.keep();
        let helper = temp.join("update-helper.exe");
        std::fs::copy(&current, &helper)?;
        let mut command = std::process::Command::new(&helper);
        command
            .arg("--state-dir")
            .arg(directory)
            .arg("__apply-update")
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .arg("--target")
            .arg(&current)
            .arg("--replacement")
            .arg(&replacement);
        if restart {
            command.arg("--restart");
        }
        command.spawn()?;
        println!("Update {version} verified. Installation will finish as this command exits.");
    }
    Ok(())
}
#[cfg(windows)]
pub fn apply_windows(
    parent: u32,
    target: &Path,
    replacement: &Path,
    directory: &Path,
    restart: bool,
) -> Result<()> {
    crate::windows::wait_for_process(parent)?;
    crate::windows::replace(replacement, target)?;
    if restart {
        Service::from_executable(target.to_owned(), directory.to_owned()).connect()?;
    }
    crate::windows::delete_on_reboot(std::env::current_exe()?)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_checksum_and_insecure_release() {
        assert!(checksum(b"bad", &"0".repeat(64)).is_err());
        assert!(secure_url("http://example.com/a").is_err());
        assert!(secure_url("https://secret@example.com/a").is_err());
    }

    #[test]
    fn release_generator_matches_the_strict_updater_manifest() {
        let directory = tempfile::tempdir().unwrap();
        for name in [
            "process-execution-daemon-linux-x86_64",
            "process-execution-daemon-macos-universal",
            "process-execution-daemon-windows-x86_64.exe",
        ] {
            std::fs::write(directory.path().join(name), b"test release bytes").unwrap();
        }
        let output = std::process::Command::new("node")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/release/manifest.mjs"))
            .arg(directory.path())
            .arg("https://downloads.example.com/releases/test/1-1/")
            .arg("0.1.0+git.test.1.1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let manifest: Manifest =
            serde_json::from_slice(&std::fs::read(directory.path().join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest.protocol_version, 1);
        assert_eq!(manifest.binary, "process-execution-daemon");
        assert_eq!(manifest.version, "0.1.0+git.test.1.1");
        assert_eq!(manifest.artifacts.len(), 4);
        for artifact in &manifest.artifacts {
            secure_url(&artifact.url).unwrap();
            checksum(b"test release bytes", &artifact.sha256).unwrap();
            assert_eq!(artifact.size_bytes, b"test release bytes".len());
        }
        assert_eq!(manifest.artifacts[1].url, manifest.artifacts[2].url);
        assert_eq!(manifest.artifacts[1].arch, "x86_64");
        assert_eq!(manifest.artifacts[2].arch, "aarch64");
    }
}
