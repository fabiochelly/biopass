//! BioPass — cœur de l'application de bureau (crypto, API, coffre, recherche, TOTP).
//! Miroir fidèle de `server/web/assets/core.js` ; voir PROTOCOL.md.

pub mod api;
pub mod crypto;
pub mod icon;
pub mod model;
pub mod session;
pub mod util;
pub mod vault;

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// Serveur injoignable (équivalent de `ApiError.status === 0`).
    Offline,
    /// Échec GCM au déchiffrement de `wrapped`.
    BadPassword,
    /// Réponse HTTP non 2xx.
    Http { status: u16, message: String, conflicts: Vec<String> },
    Other(String),
}

impl Error {
    /// Code HTTP (0 = injoignable ou erreur locale).
    pub fn status(&self) -> u16 {
        match self {
            Error::Http { status, .. } => *status,
            _ => 0,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Offline => f.write_str("Serveur injoignable"),
            Error::BadPassword => f.write_str("Mot de passe incorrect"),
            Error::Http { message, .. } => f.write_str(message),
            Error::Other(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for Error {}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
