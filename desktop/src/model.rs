//! Formulaire d'édition d'une entrée. Les champs inconnus de l'entrée sont conservés.

use serde_json::{json, Map, Value};
use zeroize::Zeroize;

use crate::util::{get_bool, get_str, get_uris};

#[derive(Debug, Clone, Default)]
pub struct Form {
    pub name: String,
    pub username: String,
    pub password: String,
    /// Une URI par ligne.
    pub uris: String,
    pub totp: String,
    pub folder: String,
    pub notes: String,
    pub fav: bool,
}

impl Form {
    pub fn from_item(m: &Map<String, Value>) -> Form {
        Form {
            name: get_str(m, "name").into(),
            username: get_str(m, "username").into(),
            password: get_str(m, "password").into(),
            uris: get_uris(m).join("\n"),
            totp: get_str(m, "totp").into(),
            folder: get_str(m, "folder").into(),
            notes: get_str(m, "notes").into(),
            fav: get_bool(m, "fav"),
        }
    }

    /// Applique le formulaire sur `base` (entrée existante, ou vide pour une création).
    /// Tous les autres champs de `base` (fields, created, champs inconnus…) sont conservés.
    pub fn apply(&self, base: &Map<String, Value>) -> Map<String, Value> {
        let mut m = base.clone();
        if get_str(&m, "type").is_empty() {
            m.insert("type".into(), json!("login"));
        }
        m.insert("name".into(), json!(self.name.trim()));
        m.insert("username".into(), json!(self.username));
        m.insert("password".into(), json!(self.password));
        let uris: Vec<&str> = self.uris.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        m.insert("uris".into(), json!(uris));
        m.insert("totp".into(), json!(self.totp.trim()));
        m.insert("folder".into(), json!(self.folder.trim()));
        m.insert("notes".into(), json!(self.notes));
        m.insert("fav".into(), json!(self.fav));
        m
    }
}

impl Drop for Form {
    fn drop(&mut self) {
        self.password.zeroize();
        self.username.zeroize();
        self.notes.zeroize();
        self.totp.zeroize();
    }
}

/// Historique des mots de passe (miroir de `withHistory` de core.js) : si le mot de passe change,
/// l'ancien est poussé en tête de `history` (10 derniers, le plus récent d'abord).
pub fn with_history(prev: &Map<String, Value>, mut next: Map<String, Value>, now_ms: u64) -> Map<String, Value> {
    let old = get_str(prev, "password");
    if old.is_empty() || old == get_str(&next, "password") {
        return next;
    }
    let mut hist = vec![json!({ "password": old, "date": now_ms })];
    if let Some(Value::Array(a)) = prev.get("history") {
        hist.extend(a.iter().cloned());
    }
    hist.truncate(10);
    next.insert("history".into(), Value::Array(hist));
    next
}

/// Entrées de l'historique lisibles : (mot de passe, date ms).
pub fn history(m: &Map<String, Value>) -> Vec<(&str, u64)> {
    m.get("history")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|h| Some((h.get("password")?.as_str()?, h.get("date").and_then(Value::as_u64).unwrap_or(0))))
                .filter(|(p, _)| !p.is_empty())
                .collect()
        })
        .unwrap_or_default()
}
