mod config;
mod http;
mod protocol;
mod runner;
mod service;
mod store;
mod update;
#[cfg(windows)]
mod windows;
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};
use uuid::Uuid;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Parser)]
#[command(
    version,
    about = "Connect this machine to the Cloudflare execution gateway"
)]
struct Cli {
    /// Private local state directory (separate from the legacy daemon).
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Register this machine. Read the management secret from stdin; never save it.
    Register {
        #[arg(long)]
        gateway_url: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        machine_id: Option<Uuid>,
        #[arg(long)]
        allow_insecure_loopback: bool,
    },
    /// Save an already-issued daemon secret from stdin.
    Configure {
        #[arg(long)]
        gateway_url: String,
        #[arg(long)]
        machine_id: Uuid,
        #[arg(long)]
        allow_insecure_loopback: bool,
    },
    /// Run in the foreground (Ctrl-C stops native sessions cleanly).
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Install and start the daemon for your login session.
    Connect {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Stop native sessions and disable automatic login startup; keep credentials and results.
    Disconnect,
    /// Restart the service, preserving registration and the delivery journal.
    Restart,
    /// Show connection state, machine ID and delivery counts without credentials.
    Status,
    /// Show retained delivery failures, or retry one quarantined delivery.
    Outbox {
        #[arg(long)]
        retry: Option<String>,
        /// Permanently discard a quarantined payload; keep its no-reexecution tombstone.
        #[arg(long, conflicts_with = "retry")]
        discard: Option<String>,
    },
    /// Install a checksum-verified release or local build, restarting if running.
    Update {
        #[arg(long, conflicts_with = "from")]
        manifest_url: Option<String>,
        #[arg(long, requires = "sha256")]
        from: Option<PathBuf>,
        #[arg(long, requires = "from")]
        sha256: Option<String>,
    },
    /// Show the binary and transport protocol versions.
    Version,
    #[cfg(windows)]
    #[command(name = "__apply-update", hide = true)]
    ApplyUpdate {
        #[arg(long)]
        parent_pid: u32,
        #[arg(long)]
        target: PathBuf,
        #[arg(long)]
        replacement: PathBuf,
        #[arg(long)]
        restart: bool,
    },
}
#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Error: {e}");
            ExitCode::from(2)
        }
    }
}
async fn run(cli: Cli) -> Result<()> {
    if matches!(cli.command, Command::Version) {
        println!(
            "process-execution-daemon {}\nGateway protocol: v1",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    let directory = cli.state_dir.unwrap_or(
        directories::BaseDirs::new()
            .ok_or("cannot find local application data directory")?
            .data_local_dir()
            .join("managed-agents-execution"),
    );
    store::private_directory(&directory)?;
    let directory = directory.canonicalize()?;
    // Serialize lifecycle commands independently of the long-lived runtime lock.
    let _control = if matches!(
        &cli.command,
        Command::Connect { .. }
            | Command::Disconnect
            | Command::Restart
            | Command::Update { .. }
            | Command::Register { .. }
            | Command::Configure { .. }
    ) {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("control.lock"))?;
        file.try_lock()
            .map_err(|_| "another daemon administration command is in progress")?;
        Some(file)
    } else {
        None
    };
    match cli.command {
        Command::Register {
            gateway_url,
            name,
            machine_id,
            allow_insecure_loopback,
        } => {
            let _lock = store::Lock::acquire(&directory)?;
            let token = token()?;
            let credential = http::register(
                &directory,
                &gateway_url,
                &name,
                machine_id,
                &token,
                allow_insecure_loopback,
            )
            .await?;
            save_local_mode(&directory, allow_insecure_loopback)?;
            println!(
                "Registered {name}.\nMachine: {}\nExecution secret saved in execution-secret.json in the state directory.\nRun `connect` to start the daemon.",
                credential.machine_id
            );
        }
        Command::Configure {
            gateway_url,
            machine_id,
            allow_insecure_loopback,
        } => {
            let _lock = store::Lock::acquire(&directory)?;
            http::credential(&gateway_url, machine_id, token()?, allow_insecure_loopback)?
                .save(&directory)?;
            save_local_mode(&directory, allow_insecure_loopback)?;
            println!("Configured machine {machine_id}.\nRun `connect` to start the daemon.");
        }
        Command::Run { config } => {
            runner::run(
                &directory,
                config::Config::load(&directory, config.as_deref())?,
            )
            .await?
        }
        Command::Connect { config } => {
            if store::running(&directory)? {
                println!("Daemon is already running.");
                return show_status(&directory);
            }
            store::Credential::load(&directory)?;
            if let Some(path) = config {
                let value = config::Config::load(&directory, Some(&path))?;
                store::write_json(&directory.join("config.json"), &value)?;
            }
            service::Service::new(directory.clone(), None)?.connect()?;
            wait_connected(&directory).await?;
        }
        Command::Disconnect => {
            stop(&directory).await?;
            service::Service::new(directory, None)?.disconnect()?;
            println!("Disconnected. Registration and undelivered results are saved.");
        }
        Command::Restart => {
            store::Credential::load(&directory)?;
            stop(&directory).await?;
            let service = service::Service::new(directory.clone(), None)?;
            service.disconnect()?;
            service.connect()?;
            wait_connected(&directory).await?;
        }
        Command::Status => show_status(&directory)?,
        Command::Outbox { retry, discard } => {
            let journal = store::Journal::open(&directory)?;
            if let Some(id) = discard {
                if !protocol::digest(&id) {
                    return Err("expected a delivery ID from `outbox`".into());
                }
                if !journal.discard(&id)? {
                    return Err("quarantined delivery not found".into());
                }
                println!("Discarded the retained result. This request will not execute again.");
            } else if let Some(id) = retry {
                if !protocol::digest(&id) {
                    return Err("expected a delivery ID from `outbox`".into());
                }
                if !journal.retry(&id)? {
                    return Err("quarantined delivery not found".into());
                }
                println!("Delivery queued for retry. Start the daemon if it is disconnected.");
            } else {
                let failures = journal.failures()?;
                if failures.is_empty() {
                    println!("No delivery failures.");
                }
                for (request, id, reason) in failures {
                    println!(
                        "Request: {request}\nReason:  {reason}\nRetry:   outbox --retry {id}\n"
                    );
                }
                print_counts(&journal)?;
            }
        }
        Command::Update {
            manifest_url,
            from,
            sha256,
        } => {
            let mut config = config::Config::load(&directory, None)?;
            let selected = manifest_url
                .as_deref()
                .or(config.update_manifest_url.as_deref());
            update::apply(&directory, selected, from.as_deref(), sha256.as_deref()).await?;
            if let Some(url) = manifest_url {
                config.update_manifest_url = Some(url);
                store::write_json(&directory.join("config.json"), &config)?;
            }
        }
        Command::Version => unreachable!(),
        #[cfg(windows)]
        Command::ApplyUpdate {
            parent_pid,
            target,
            replacement,
            restart,
        } => update::apply_windows(parent_pid, &target, &replacement, &directory, restart)?,
    }
    Ok(())
}
fn save_local_mode(directory: &Path, enabled: bool) -> Result<()> {
    let mut c = config::Config::load(directory, None)?;
    c.allow_insecure_loopback = enabled;
    store::write_json(&directory.join("config.json"), &c)
}
fn token() -> Result<String> {
    eprintln!("Reading credential from stdin.");
    let mut bytes = Vec::new();
    let read = std::io::Read::take(io::stdin().lock(), 32769).read_until(b'\n', &mut bytes)?;
    if read == 0 || read > 32768 {
        return Err("credential must be a single nonempty line of at most 32768 bytes".into());
    }
    let token = String::from_utf8(bytes)?
        .trim_end_matches(['\r', '\n'])
        .to_owned();
    if token.is_empty()
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b))
    {
        return Err("invalid credential characters".into());
    }
    Ok(token)
}
fn show_status(directory: &Path) -> Result<()> {
    let running = store::running(directory)?;
    let credential = store::Credential::load(directory).ok();
    let status = std::fs::read(directory.join("status.json"))
        .ok()
        .and_then(|v| serde_json::from_slice::<Value>(&v).ok());
    let state = if running {
        status
            .as_ref()
            .and_then(|v| v["state"].as_str())
            .unwrap_or("starting")
    } else {
        "stopped"
    };
    println!("Daemon: {state}");
    if let Some(c) = credential {
        println!("Machine: {}\nGateway: {}", c.machine_id, c.gateway_url);
    } else {
        println!("Not registered. Run `register` or `configure` first.");
    }
    if directory.join("journal.sqlite").exists() {
        print_counts(&store::Journal::open(directory)?)?;
    }
    Ok(())
}
fn print_counts(journal: &store::Journal) -> Result<()> {
    let rows = journal.summary()?;
    let active = rows
        .iter()
        .find(|(s, _)| s == "active")
        .map_or(0, |(_, n)| *n);
    let pending = rows
        .iter()
        .find(|(s, _)| s == "pending")
        .map_or(0, |(_, n)| *n);
    let failed = rows
        .iter()
        .find(|(s, _)| s == "quarantined")
        .map_or(0, |(_, n)| *n);
    println!("Work: {active} running · {pending} awaiting delivery · {failed} need attention");
    Ok(())
}
async fn stop(directory: &Path) -> Result<()> {
    if !store::running(directory)? {
        return Ok(());
    }
    let status: Value = serde_json::from_slice(&std::fs::read(directory.join("status.json"))?)?;
    let generation = status["runtimeGeneration"]
        .as_str()
        .ok_or("daemon has not published its identity; retry shortly")?;
    store::write_json(
        &directory.join("stop.json"),
        &json!({"generation":generation}),
    )?;
    let timeout = config::Config::load(directory, None)?.shutdown_seconds + 5;
    tokio::time::timeout(Duration::from_secs(timeout), async {
        while store::running(directory)? {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    })
    .await
    .map_err(|_| "daemon did not stop; inspect its log before retrying")??;
    Ok(())
}
async fn wait_connected(directory: &Path) -> Result<()> {
    for _ in 0..100 {
        if store::running(directory)? {
            let value = std::fs::read(directory.join("status.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            if value.as_ref().is_some_and(|v| v["state"] == "connected") {
                println!("Connected.");
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if store::running(directory)? {
        println!("Daemon started; waiting for gateway connection. Run `status` for details.");
        Ok(())
    } else {
        Err("daemon did not stay running; inspect the daemon log in the state directory".into())
    }
}
