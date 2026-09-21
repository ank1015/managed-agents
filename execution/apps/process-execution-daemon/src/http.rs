use crate::{
    Result, config,
    store::{self, Credential},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
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
pub fn token_claims(token: &str) -> Result<Value> {
    if token.len() > 32768
        || !token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err("invalid machine token".into());
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("expected a gateway-issued machine token".into());
    }
    let v: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1])?)?;
    if v["kind"] != "machine"
        || v["aud"] != "managed-execution-v1"
        || v["exp"].as_i64().unwrap_or(0) <= store::now() / 1000
    {
        return Err("machine token is expired or has the wrong purpose".into());
    }
    // Parsing binds local configuration; the gateway verifies its signature.
    Ok(v)
}
pub fn credential(
    url: &str,
    user: &str,
    machine: Uuid,
    token: String,
    insecure: bool,
) -> Result<Credential> {
    let url = config::gateway(url, insecure)?;
    let claims = token_claims(&token)?;
    if !crate::protocol::identity(user)
        || claims["sub"] != user
        || claims["machineId"] != machine.to_string()
    {
        return Err("machine token belongs to a different user or machine".into());
    }
    Ok(Credential {
        gateway_url: url.to_string(),
        user_id: user.into(),
        machine_id: machine,
        token,
    })
}
pub async fn register(
    directory: &Path,
    url: &str,
    user: &str,
    name: &str,
    machine: Option<Uuid>,
    backend: &str,
    insecure: bool,
) -> Result<Credential> {
    let gateway = config::gateway(url, insecure)?;
    if !crate::protocol::identity(user)
        || name.is_empty()
        || name.len() > 128
        || name.chars().any(char::is_control)
    {
        return Err("invalid user ID or machine name".into());
    }
    // Save the enrollment identity before network I/O so interrupted registration retries reuse it.
    let file = directory.join("registration.json");
    let proposed = json!({"gateway":gateway.as_str(),"user":user,"name":name});
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
        && (old.machine_id != id || old.user_id != user || old.gateway_url != gateway.as_str())
    {
        return Err("existing credential belongs to another enrollment".into());
    }
    let client = client()?;
    json_request(
        &client,
        gateway.join(&format!("/v1/users/{user}/machines"))?,
        backend,
        json!({"machineId":id,"name":name}),
    )
    .await?;
    let value = json_request(
        &client,
        gateway.join(&format!("/v1/users/{user}/machines/{id}/token"))?,
        backend,
        json!({}),
    )
    .await?;
    let token = value["token"]
        .as_str()
        .ok_or("gateway omitted machine token")?
        .to_owned();
    let credential = credential(gateway.as_str(), user, id, token, insecure)?;
    credential.save(directory)?;
    Ok(credential)
}
pub async fn refresh(directory: &Path, credential: &mut Credential) -> Result<()> {
    let value = json_request(
        &client()?,
        Url::parse(&credential.gateway_url)?.join("/v1/machine-token/refresh")?,
        &credential.token,
        json!({}),
    )
    .await?;
    let token = value["token"]
        .as_str()
        .ok_or("gateway omitted refreshed token")?
        .to_owned();
    let claims = token_claims(&token)?;
    if claims["sub"] != credential.user_id
        || claims["machineId"] != credential.machine_id.to_string()
    {
        return Err("refreshed token has the wrong owner".into());
    }
    let mut changed = credential.clone();
    changed.token = token;
    changed.save(directory)?;
    *credential = changed;
    Ok(())
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
