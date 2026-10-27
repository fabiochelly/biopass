//! Réglages locaux et session persistante (« Rester déverrouillé »).
//!
//! La session conserve sur ce poste la clé brute du coffre et l'`auth` dérivée jusqu'à une échéance,
//! pour rouvrir le coffre sans mot de passe même après un redémarrage de l'application (comme
//! `Vault.resume` de core.js, l'extension et Android). « Verrouiller » efface le fichier.
//! L'échéance est glissante : elle est repoussée tant que l'application est utilisée.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::Error;

// ------------------------------------------------------------------ réglages

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClipboardClear {
    Never,
    Secs30,
    Mins2,
}

impl ClipboardClear {
    pub const ALL: [ClipboardClear; 3] = [ClipboardClear::Never, ClipboardClear::Secs30, ClipboardClear::Mins2];

    pub fn secs(self) -> Option<u64> {
        match self {
            ClipboardClear::Never => None,
            ClipboardClear::Secs30 => Some(30),
            ClipboardClear::Mins2 => Some(120),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ClipboardClear::Never => "Jamais",
            ClipboardClear::Secs30 => "30 s",
            ClipboardClear::Mins2 => "2 min",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StayUnlocked {
    Mins5,
    Hour1,
    Hours8,
    Hours48,
    Always,
}

impl StayUnlocked {
    pub const ALL: [StayUnlocked; 5] =
        [StayUnlocked::Mins5, StayUnlocked::Hour1, StayUnlocked::Hours8, StayUnlocked::Hours48, StayUnlocked::Always];

    /// Durée en millisecondes ; None = toujours.
    pub fn millis(self) -> Option<u64> {
        match self {
            StayUnlocked::Mins5 => Some(5 * 60_000),
            StayUnlocked::Hour1 => Some(3_600_000),
            StayUnlocked::Hours8 => Some(8 * 3_600_000),
            StayUnlocked::Hours48 => Some(48 * 3_600_000),
            StayUnlocked::Always => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            StayUnlocked::Mins5 => "5 min",
            StayUnlocked::Hour1 => "1 h",
            StayUnlocked::Hours8 => "8 h",
            StayUnlocked::Hours48 => "48 h",
            StayUnlocked::Always => "Toujours",
        }
    }

    /// Échéance (ms) si l'application est utilisée à l'instant `now_ms` ; None = jamais.
    pub fn deadline(self, now_ms: u64) -> Option<u64> {
        self.millis().map(|d| now_ms.saturating_add(d))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub clipboard_clear: ClipboardClear,
    pub stay_unlocked: StayUnlocked,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { clipboard_clear: ClipboardClear::Never, stay_unlocked: StayUnlocked::Hours48 }
    }
}

impl Settings {
    /// Lecture tolérante : fichier absent ou illisible → réglages par défaut.
    pub fn load(path: &Path) -> Settings {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), Error> {
        crate::vault::write_private(path, serde_json::to_vec_pretty(self).expect("JSON").as_slice())
    }
}

// ------------------------------------------------------------------ session

/// Contenu de `session.json`. Secrets effacés de la mémoire à la destruction.
#[derive(Serialize, Deserialize)]
pub struct SessionFile {
    pub server: String,
    pub user: String,
    /// Clé brute du coffre, en base64.
    pub key: String,
    /// `b64(authKey)` : permet d'obtenir un token sans le mot de passe.
    pub auth: String,
    /// Échéance en ms depuis l'époque ; None = toujours.
    pub expires: Option<u64>,
}

impl Drop for SessionFile {
    fn drop(&mut self) {
        self.key.zeroize();
        self.auth.zeroize();
    }
}

impl SessionFile {
    pub fn expired(&self, now_ms: u64) -> bool {
        self.expires.is_some_and(|e| now_ms >= e)
    }
}

#[derive(Debug, Clone)]
pub struct SessionStore {
    pub path: PathBuf,
}

impl SessionStore {
    pub fn new(path: impl Into<PathBuf>) -> SessionStore {
        SessionStore { path: path.into() }
    }

    /// `session.json` à côté de `cache.json`.
    pub fn default_path() -> PathBuf {
        crate::vault::Storage::default_path().with_file_name("session.json")
    }

    /// Écriture atomique, permissions 0600.
    pub fn save(&self, s: &SessionFile) -> Result<(), Error> {
        let data = Zeroizing::new(serde_json::to_vec(s).expect("JSON"));
        crate::vault::write_private(&self.path, &data)
    }

    /// Session valide à l'instant `now_ms`. Une session expirée ou illisible est supprimée.
    pub fn load(&self, now_ms: u64) -> Option<SessionFile> {
        let bytes = Zeroizing::new(std::fs::read(&self.path).ok()?);
        match serde_json::from_slice::<SessionFile>(&bytes) {
            Ok(s) if !s.expired(now_ms) => Some(s),
            _ => {
                self.clear();
                None
            }
        }
    }

    /// Efface le fichier (contenu écrasé avant suppression, au mieux).
    pub fn clear(&self) {
        if let Ok(meta) = std::fs::metadata(&self.path) {
            let _ = std::fs::write(&self.path, vec![0u8; meta.len() as usize]);
        }
        let _ = std::fs::remove_file(&self.path);
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }
}
