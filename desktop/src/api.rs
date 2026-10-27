//! Client HTTP de l'API BioPass (PROTOCOL.md §2), bloquant — à appeler hors du thread de l'UI.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::Error;

#[derive(Clone)]
pub struct Api {
    /// Adresse normalisée (`normServer`), clé d'accès comprise.
    pub server: String,
    /// Origine + chemin, sans clé.
    pub base: String,
    /// Clé d'accès optionnelle (en-tête `X-BP-Key`).
    pub key: String,
    pub token: Option<String>,
    agent: ureq::Agent,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Prelogin {
    pub salt: String,
    pub iter: u32,
}

/// Réponse de `login` / `register`.
#[derive(Debug, Clone, Deserialize)]
pub struct Session {
    pub user: String,
    pub token: String,
    pub salt: String,
    pub iter: u32,
    pub wrapped: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncItem {
    pub id: String,
    pub rev: u64,
    #[serde(default)]
    pub enc: Option<String>,
    #[serde(default)]
    pub del: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncResponse {
    pub rev: u64,
    #[serde(default)]
    pub full: bool,
    #[serde(default)]
    pub items: Vec<SyncItem>,
}

/// Adresse du serveur décomposée (cf. `parseServer` de core.js).
#[derive(Debug, Clone, PartialEq)]
pub struct ServerAddr {
    pub base: String,
    pub key: String,
}

/// « https://example.com/biopass/?k=GUID » → { base: "https://example.com/biopass", key: "GUID" }.
/// Schéma https:// par défaut ; `/index.html`, `/index.php`, `/api.php` et `/` finaux retirés. "." = même origine.
pub fn parse_server(input: &str) -> Result<ServerAddr, Error> {
    let s = input.trim();
    if s.is_empty() || s == "." {
        return Ok(ServerAddr { base: ".".into(), key: String::new() });
    }
    let lower = s.to_ascii_lowercase();
    let full = if lower.starts_with("http://") || lower.starts_with("https://") { s.to_string() } else { format!("https://{s}") };
    let u = url::Url::parse(&full).map_err(|_| Error::Other("Adresse du serveur invalide".into()))?;
    let mut path = u.path();
    for suffix in ["/index.html", "/index.php", "/api.php"] {
        if let Some(p) = path.strip_suffix(suffix) {
            path = p;
            break;
        }
    }
    let path = path.trim_end_matches('/');
    let key = u.query_pairs().find(|(k, _)| k == "k").map(|(_, v)| v.into_owned()).unwrap_or_default();
    Ok(ServerAddr { base: format!("{}{path}", u.origin().ascii_serialization()), key })
}

/// `encodeURIComponent` de JS.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Forme normalisée à stocker dans le profil (clé comprise), cf. `normServer`.
pub fn norm_server(input: &str) -> Result<String, Error> {
    Ok(parse_server(input)?.norm())
}

impl ServerAddr {
    /// Forme `normServer` : base + `/?k=<clé encodée>` si une clé est présente.
    pub fn norm(&self) -> String {
        if self.key.is_empty() {
            self.base.clone()
        } else {
            format!("{}/?k={}", self.base, encode_uri_component(&self.key))
        }
    }
}

/// URL de l'app web correspondante, cf. `webUrl`.
pub fn web_url(server: &str) -> Result<String, Error> {
    let a = parse_server(server)?;
    let q = if a.key.is_empty() { String::new() } else { format!("?k={}", encode_uri_component(&a.key)) };
    Ok(format!("{}/{q}", a.base))
}

/// Adresse affichable : la base seule, jamais la clé.
pub fn display_server(server: &str) -> String {
    parse_server(server).map(|a| a.base).unwrap_or_default()
}

impl Api {
    pub fn new(server: &str) -> Api {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(6))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("BioPass-desktop/", env!("CARGO_PKG_VERSION")))
            .build();
        let addr = parse_server(server).unwrap_or_else(|_| ServerAddr { base: server.trim().to_string(), key: String::new() });
        Api { server: server.to_string(), base: addr.base, key: addr.key, token: None, agent }
    }

    pub fn call(&self, action: &str, body: Option<&Value>, query: &str) -> Result<Value, Error> {
        let url = format!("{}/api.php?a={action}{query}", self.base);
        let mut req = if body.is_some() { self.agent.post(&url) } else { self.agent.get(&url) };
        req = req.set("Cache-Control", "no-store");
        if !self.key.is_empty() {
            req = req.set("X-BP-Key", &self.key);
        }
        if let Some(t) = &self.token {
            req = req.set("X-BP-Token", t);
        }
        let res = match body {
            Some(b) => req.set("Content-Type", "application/json").send_string(&b.to_string()),
            None => req.call(),
        };
        match res {
            Ok(r) => {
                let text = r.into_string().map_err(|_| Error::Offline)?;
                serde_json::from_str(&text).map_err(|_| Error::Other("Réponse du serveur invalide".into()))
            }
            Err(ureq::Error::Status(status, r)) => {
                let data: Value = r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
                // Sans clé d'accès valide, le serveur répond 404 sur tout.
                let message = if status == 404 {
                    "Serveur introuvable ou clé d'accès incorrecte".to_string()
                } else {
                    data.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("Erreur serveur ({status})"))
                };
                let conflicts = data
                    .get("conflicts")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                Err(Error::Http { status, message, conflicts })
            }
            Err(ureq::Error::Transport(_)) => Err(Error::Offline),
        }
    }

    fn parse<T: for<'de> Deserialize<'de>>(v: Value) -> Result<T, Error> {
        serde_json::from_value(v).map_err(|_| Error::Other("Réponse du serveur inattendue".into()))
    }

    pub fn prelogin(&self, user: &str) -> Result<Prelogin, Error> {
        Self::parse(self.call("prelogin", Some(&json!({ "user": user })), "")?)
    }

    pub fn login(&self, user: &str, auth: &str) -> Result<Session, Error> {
        Self::parse(self.call("login", Some(&json!({ "user": user, "auth": auth })), "")?)
    }

    pub fn register(&self, user: &str, code: &str, salt: &str, iter: u32, auth: &str, wrapped: &str) -> Result<Session, Error> {
        let body = json!({ "user": user, "code": code, "salt": salt, "iter": iter, "auth": auth, "wrapped": wrapped });
        Self::parse(self.call("register", Some(&body), "")?)
    }

    pub fn sync(&self, since: u64) -> Result<SyncResponse, Error> {
        Self::parse(self.call("sync", None, &format!("&since={since}"))?)
    }

    /// `changes` : [{id, prev, enc}] ou [{id, prev, del:true}] → nouvelle rev.
    pub fn save(&self, changes: &[Value]) -> Result<u64, Error> {
        let r = self.call("save", Some(&json!({ "changes": changes })), "")?;
        r.get("rev").and_then(Value::as_u64).ok_or_else(|| Error::Other("Réponse du serveur inattendue".into()))
    }

    /// Changement du mot de passe maître → nouveau token.
    pub fn password(&self, auth: &str, salt: &str, iter: u32, auth_new: &str, wrapped: &str) -> Result<String, Error> {
        let body = json!({ "auth": auth, "salt": salt, "iter": iter, "auth_new": auth_new, "wrapped": wrapped });
        let r = self.call("password", Some(&body), "")?;
        r.get("token").and_then(Value::as_str).map(str::to_string).ok_or_else(|| Error::Other("Réponse du serveur inattendue".into()))
    }
}
