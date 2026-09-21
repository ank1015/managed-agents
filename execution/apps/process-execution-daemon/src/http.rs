use crate::{
    Result, config,
    store::{self, Credential},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use url::Url;
use uuid::Uuid;

pub fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()?)
}
pub async fn json_request(
    client: &reqwest::Client,
    url: Url,
    token: &str,
    body: Value,
) -> Result<Value> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let bytes = limited(response, 65536).await?;
    if !status.is_success() {
        let code = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v["error"]["code"].as_str().map(String::from))
            .filter(|s| crate::protocol::identity(s))
            .unwrap_or_else(|| "UNAVAILABLE".into());
        return Err(format!("gateway returned {status} ({code})").into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub async fn limited(mut response: reqwest::Response, maximum: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|v| v > maximum as u64)
    {
        return Err("HTTP response exceeds size limit".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if data.len() + chunk.len() > maximum {
            return Err("HTTP response exceeds size limit".into());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
pub fn credential(url: &str, machine: Uuid, token: String, insecure: bool) -> Result<Credential> {
    let url = config::gateway(url, insecure)?;
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 4
        || parts[0] != "md1"
        || Uuid::parse_str(parts[1]).ok() != Some(machine)
        || parts[2].parse::<u64>().ok().filter(|v| *v > 0).is_none()
        || parts[3].len() != 43
        || !parts[3]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err(
            "expected this machine's daemon secret (md1); execution secrets cannot connect".into(),
        );
    }
    Ok(Credential {
        gateway_url: url.to_string(),
        machine_id: machine,
        token,
    })
}
pub async fn register(
    directory: &Path,
    url: &str,
    name: &str,
    machine: Option<Uuid>,
    management: &str,
    insecure: bool,
) -> Result<Credential> {
    let gateway = config::gateway(url, insecure)?;
    if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
        return Err("invalid machine name".into());
    }
    // Persist before network I/O. A lost response reissues the same initial secrets.
    let file = directory.join("registration.json");
    let proposed = json!({"gateway":gateway.as_str(),"name":name});
    let id = if file.exists() {
        let old: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
        if old["input"] != proposed {
            return Err("registration differs from this state directory's saved enrollment; use the original settings or a new state directory".into());
        }
        let id: Uuid = serde_json::from_value(old["machineId"].clone())?;
        if machine.is_some_and(|m| m != id) {
            return Err("machine ID differs from saved enrollment".into());
        }
        id
    } else {
        let id = machine.unwrap_or_else(Uuid::new_v4);
        store::write_json(&file, &json!({"input":proposed,"machineId":id}))?;
        id
    };
    if let Ok(old) = Credential::load(directory)
        && (old.machine_id != id || old.gateway_url != gateway.as_str())
    {
        return Err("existing credential belongs to another enrollment".into());
    }
    let value = json_request(
        &client()?,
        gateway.join("/v1/machines")?,
        management,
        json!({"machineId":id,"name":name}),
    )
    .await?;
    if value["machine"]["machineId"] != id.to_string() {
        return Err("gateway returned another machine identity".into());
    }
    let token = value["daemonSecret"]
        .as_str()
        .ok_or("gateway omitted daemon secret")?
        .to_owned();
    let execution = value["executionSecret"]
        .as_str()
        .ok_or("gateway omitted execution secret")?;
    let credential = credential(gateway.as_str(), id, token, insecure)?;
    credential.save(directory)?;
    store::write_json(
        &directory.join("execution-secret.json"),
        &json!({"machineId":id,"executionSecret":execution}),
    )?;
    Ok(credential)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_disallows_credential_redirection() {
        for value in [
            "http://remote.example",
            "https://example.com/path",
            "https://user:secret@example.com",
            "https://example.com?token=x",
        ] {
            assert!(config::gateway(value, false).is_err());
        }
        assert!(config::gateway("http://127.0.0.1:8787", true).is_ok());
        assert!(config::gateway("http://127.0.0.1:8787", false).is_err());
    }
}
