//! App-owned browser approval. No management/execution credential is sent to or
//! accepted from this endpoint. The private attempt credential never enters a URL.
use crate::{
    Result, config, http,
    store::{self, Credential},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::Duration};
use tokio::time::{self, Instant};
use url::Url;
use uuid::Uuid;

const FILE: &str = "enrollment.json";
const LIFETIME_MS: i64 = 15 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MachineIdentity {
    gateway_url: String,
    machine_id: Uuid,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attempt {
    registration_id: Uuid,
    polling_secret: String,
    expires_at: i64,
    request: Value,
    approved: Option<Credential>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    url: String,
    name: Option<String>,
    insecure: bool,
    pending: Option<Attempt>,
}
impl State {
    fn save(&self, directory: &Path) -> Result<()> {
        store::write_json(&directory.join(FILE), self)
    }
}

pub struct Approved {
    pub credential: Credential,
    pub insecure: bool,
    state: State,
}
impl Approved {
    pub fn finish(&self, directory: &Path) -> Result<()> {
        State {
            url: self.state.url.clone(),
            name: self.state.name.clone(),
            insecure: self.insecure,
            pending: None,
        }
        .save(directory)
    }
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum Reply {
    #[serde(rename_all = "camelCase")]
    Pending {
        verification_url: String,
        user_code: String,
        expires_at: i64,
        interval_seconds: u64,
    },
    #[serde(rename_all = "camelCase")]
    Approved {
        gateway_url: String,
        machine_id: Uuid,
        daemon_secret: String,
    },
    Denied,
    Expired,
}
enum Response {
    Reply(Reply),
    Retry(u64),
}

fn endpoint(value: &str, insecure: bool) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "invalid enrollment URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if value.len() > 4096
        || value.chars().any(char::is_control)
        || (url.scheme() != "https" && !(insecure && local && url.scheme() == "http"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("enrollment URLs must use HTTPS without embedded credentials or fragments (HTTP loopback requires --allow-insecure-loopback)".into());
    }
    Ok(url)
}

fn load(directory: &Path, url: Option<&str>, name: Option<&str>, insecure: bool) -> Result<State> {
    let path = directory.join(FILE);
    let old: Option<State> = if path.exists() {
        Some(serde_json::from_slice(&std::fs::read(path)?)?)
    } else {
        None
    };
    let selected = url.or(old.as_ref().map(|s| s.url.as_str()))
        .ok_or("provide --url APP_ENROLLMENT_URL, or --gateway-url GATEWAY --name NAME for direct registration with a management secret")?;
    let insecure = insecure
        || old
            .as_ref()
            .is_some_and(|s| s.url == selected && s.insecure);
    let selected = endpoint(selected, insecure)?.to_string();
    let selected_name = name.map(str::to_owned).or_else(|| {
        old.as_ref()
            .filter(|s| s.url == selected)
            .and_then(|s| s.name.clone())
    });
    if selected_name
        .as_ref()
        .is_some_and(|n| n.is_empty() || n.len() > 128 || n.chars().any(char::is_control))
    {
        return Err("invalid machine name".into());
    }
    let mut state = if let Some(old) = old {
        if old.url == selected && old.name == selected_name {
            old
        } else {
            if old
                .pending
                .as_ref()
                .is_some_and(|p| p.approved.is_some() || p.expires_at > store::now())
            {
                return Err("an enrollment is pending; run `register` without arguments to resume it before changing the app URL or name".into());
            }
            State {
                url: selected,
                name: selected_name,
                insecure,
                pending: None,
            }
        }
    } else {
        State {
            url: selected,
            name: selected_name,
            insecure,
            pending: None,
        }
    };
    if state
        .pending
        .as_ref()
        .is_some_and(|p| p.approved.is_none() && p.expires_at <= store::now())
    {
        state.pending = None;
    }
    if state.pending.is_none() {
        let existing = if directory.join("credential.json").exists() {
            let c = Credential::load(directory)?;
            Some(MachineIdentity {
                gateway_url: c.gateway_url,
                machine_id: c.machine_id,
            })
        } else {
            None
        };
        let id = Uuid::new_v4();
        // Two independent OS-random UUIDs provide 244 bits of entropy. Neither
        // this credential nor current machine secrets is displayed/sent to the browser.
        let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        state.pending = Some(Attempt {
            registration_id: id,
            polling_secret: secret,
            expires_at: store::now() + LIFETIME_MS,
            request: json!({"protocolVersion":1,"action":"start","registrationId":id,
                "name":state.name,"existingMachine":existing,
                "daemon":{"version":env!("CARGO_PKG_VERSION"),"os":std::env::consts::OS,"arch":std::env::consts::ARCH}}),
            approved: None,
        });
    }
    state.save(directory)?;
    Ok(state)
}

async fn exchange(
    client: &reqwest::Client,
    url: &Url,
    attempt: &Attempt,
    start: bool,
) -> Result<Response> {
    let poll =
        json!({"protocolVersion":1,"action":"poll","registrationId":attempt.registration_id});
    let response = match client
        .post(url.clone())
        .bearer_auth(&attempt.polling_secret)
        .json(if start { &attempt.request } else { &poll })
        .send()
        .await
    {
        Ok(response) => response,
        Err(error)
            if error.is_timeout()
                || error.is_connect()
                || error.is_body()
                || error.is_request() =>
        {
            return Ok(Response::Retry(5));
        }
        Err(_) => return Err("enrollment request failed".into()),
    };
    let status = response.status();
    if status.as_u16() == 429 || status.is_server_error() {
        let delay = response
            .headers()
            .get("Retry-After")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(5)
            .clamp(1, 60);
        return Ok(Response::Retry(delay));
    }
    if !status.is_success() {
        // Do not reflect arbitrary response bodies, URLs, or credentials in logs.
        return Err(format!(
            "enrollment endpoint returned HTTP {}; existing credentials were not changed",
            status.as_u16()
        )
        .into());
    }
    if response
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| {
            !v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
    {
        return Err("enrollment endpoint must return application/json".into());
    }
    let bytes = match http::limited(response, 16384).await {
        Ok(bytes) => bytes,
        // A lost response body is still a retry of this exact enrollment, not a
        // reason to create another machine/rotation or discard the private attempt.
        Err(error) if error.downcast_ref::<reqwest::Error>().is_some() => {
            return Ok(Response::Retry(5));
        }
        Err(_) => return Err("could not read a bounded enrollment response".into()),
    };
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "invalid enrollment response JSON")?;
    if value["protocolVersion"] != 1
        || value["registrationId"] != attempt.registration_id.to_string()
    {
        return Err("enrollment response has the wrong protocol version or registration ID".into());
    }
    let object = value.as_object_mut().ok_or("invalid enrollment response")?;
    object.remove("protocolVersion");
    object.remove("registrationId");
    Ok(Response::Reply(
        serde_json::from_value(value).map_err(|_| "invalid enrollment response shape")?,
    ))
}

pub async fn authorize(
    directory: &Path,
    url: Option<&str>,
    name: Option<&str>,
    insecure: bool,
) -> Result<Approved> {
    // Detect invalid existing runtime configuration before asking the app to rotate.
    config::Config::load(directory, None)?;
    let mut state = load(directory, url, name, insecure)?;
    let client = http::client()?;
    let url = endpoint(&state.url, state.insecure)?;
    let remaining = state
        .pending
        .as_ref()
        .unwrap()
        .expires_at
        .saturating_sub(store::now())
        .max(0) as u64;
    let mut deadline = Instant::now() + Duration::from_millis(remaining.min(LIFETIME_MS as u64));
    let mut start = true;
    let mut displayed = None;
    let mut delay = 0;
    loop {
        if let Some(c) = state.pending.as_ref().unwrap().approved.clone() {
            c.ensure_same_identity(directory)?;
            return Ok(Approved {
                credential: c,
                insecure: state.insecure,
                state,
            });
        }
        let response = time::timeout_at(deadline, async {
            time::sleep(Duration::from_secs(delay)).await;
            exchange(&client, &url, state.pending.as_ref().unwrap(), start).await
        })
        .await;
        let response = match response {
            Ok(response) => response?,
            Err(_) => {
                state.pending = None;
                state.save(directory)?;
                return Err("Registration expired. Run `register` again to request a new approval; existing credentials were not changed.".into());
            }
        };
        match response {
            Response::Retry(seconds) => {
                delay = (delay.saturating_mul(2)).max(seconds).min(60);
            }
            Response::Reply(Reply::Pending {
                verification_url,
                user_code,
                expires_at,
                interval_seconds,
            }) => {
                let verification = endpoint(&verification_url, state.insecure)?;
                if verification_url.contains(&state.pending.as_ref().unwrap().polling_secret)
                    || user_code.is_empty()
                    || user_code.len() > 32
                    || !user_code
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || !(1..=30).contains(&interval_seconds)
                    || expires_at <= store::now()
                {
                    return Err("invalid enrollment approval code, expiry, or poll interval".into());
                }
                let attempt = state.pending.as_mut().unwrap();
                // Neither repeated pending replies nor clock changes extend the attempt.
                attempt.expires_at = attempt.expires_at.min(expires_at);
                let remaining = attempt.expires_at.saturating_sub(store::now()).max(0) as u64;
                deadline = deadline.min(Instant::now() + Duration::from_millis(remaining));
                if displayed
                    .as_ref()
                    .is_some_and(|old| old != &(verification.to_string(), user_code.clone()))
                {
                    return Err("enrollment approval URL/code changed during polling".into());
                }
                if displayed.is_none() {
                    println!(
                        "Open this URL to approve this machine:\n{verification}\nConfirmation code: {user_code}\nOnly approve if the browser shows this code. Waiting for approval..."
                    );
                    std::io::stdout().flush()?;
                    displayed = Some((verification.to_string(), user_code));
                }
                state.save(directory)?;
                start = false;
                delay = interval_seconds;
            }
            Response::Reply(Reply::Approved {
                gateway_url,
                machine_id,
                daemon_secret,
            }) => {
                let credential =
                    http::credential(&gateway_url, machine_id, daemon_secret, state.insecure)?;
                credential.ensure_same_identity(directory)?;
                if let Some(existing) = state
                    .pending
                    .as_ref()
                    .unwrap()
                    .request
                    .get("existingMachine")
                    .filter(|v| !v.is_null())
                {
                    let existing: MachineIdentity = serde_json::from_value(existing.clone())?;
                    if existing.machine_id != machine_id
                        || existing.gateway_url != credential.gateway_url
                    {
                        return Err("re-enrollment must retain the same gateway and machine ID; use a separate --state-dir for another machine".into());
                    }
                }
                // Persist approval before stopping a runtime. A crash after remote
                // rotation must not require the now-revoked old daemon credential.
                state.pending.as_mut().unwrap().approved = Some(credential);
                state.save(directory)?;
            }
            Response::Reply(Reply::Denied | Reply::Expired) => {
                state.pending = None;
                state.save(directory)?;
                return Err("Registration denied or expired. Run `register` to try again; existing credentials were not changed.".into());
            }
        }
    }
}

#[cfg(test)]
mod tests;
