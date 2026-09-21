#[cfg(unix)]
use sha2::{Digest, Sha256};
use std::{fs, process::Command};
const BIN: &str = env!("CARGO_BIN_EXE_process-execution-daemon");
#[test]
fn cli_is_readable_and_update_verifies_before_replacing_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let status = Command::new(BIN)
        .arg("--state-dir")
        .arg(&state)
        .arg("status")
        .output()
        .unwrap();
    assert!(status.status.success());
    let text = String::from_utf8(status.stdout).unwrap();
    assert!(text.contains("Daemon: stopped"));
    assert!(text.contains("Not registered"));
    assert!(!text.trim_start().starts_with('{'));
    let version = Command::new(BIN).arg("version").output().unwrap();
    assert!(String::from_utf8_lossy(&version.stdout).contains("Gateway protocol: v1"));
    let help = Command::new(BIN).arg("--help").output().unwrap();
    let help = String::from_utf8_lossy(&help.stdout);
    for command in [
        "register",
        "configure",
        "run",
        "connect",
        "disconnect",
        "restart",
        "status",
        "outbox",
        "update",
    ] {
        assert!(help.contains(command));
    }
    // Update only a temporary copy of the executable, never the developer's installation.
    let installed = dir.path().join(if cfg!(windows) {
        "daemon.exe"
    } else {
        "daemon"
    });
    fs::copy(BIN, &installed).unwrap();
    let before = fs::read(&installed).unwrap();
    let rejected = Command::new(&installed)
        .arg("--state-dir")
        .arg(&state)
        .args(["update", "--from", BIN, "--sha256", &"0".repeat(64)])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("checksum"));
    assert_eq!(fs::read(&installed).unwrap(), before);
    #[cfg(unix)]
    {
        let hash = format!("{:x}", Sha256::digest(&before));
        let updated = Command::new(&installed)
            .arg("--state-dir")
            .arg(&state)
            .args(["update", "--from", BIN, "--sha256", &hash])
            .output()
            .unwrap();
        assert!(
            updated.status.success(),
            "{}",
            String::from_utf8_lossy(&updated.stderr)
        );
        assert!(String::from_utf8_lossy(&updated.stdout).contains("Updated to local build"));
        assert_eq!(fs::read(&installed).unwrap(), before);
    }
}
