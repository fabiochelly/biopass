//! Cryptographie BioPass (PROTOCOL.md §1) — miroir de core.js.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hkdf::Hkdf;
use serde_json::{Map, Value};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

use crate::Error;

pub const DEFAULT_ITER: u32 = 600_000;

pub type Key = Zeroizing<[u8; 32]>;

pub fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn unb64(s: &str) -> Result<Vec<u8>, Error> {
    STANDARD
        .decode(s.trim())
        .map_err(|_| Error::Other("Donnée base64 invalide".into()))
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("générateur aléatoire du système indisponible");
    b
}

/// Identifiant d'entrée : 16 octets aléatoires en hexadécimal minuscule.
pub fn new_id() -> String {
    random_bytes::<16>().iter().map(|b| format!("{b:02x}")).collect()
}

fn hkdf(ikm: &[u8], info: &str) -> Key {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), out.as_mut()).expect("longueur HKDF valide");
    out
}

/// Clés dérivées du mot de passe maître.
pub struct DerivedKeys {
    /// `b64(authKey)`, envoyé au serveur.
    pub auth: Zeroizing<String>,
    pub wrap_key: Key,
}

/// Mot de passe maître → { auth, wrapKey } (PBKDF2-SHA256 puis HKDF).
pub fn derive_keys(password: &str, salt_b64: &str, iter: u32) -> Result<DerivedKeys, Error> {
    let salt = unb64(salt_b64)?;
    let pw: Zeroizing<String> = Zeroizing::new(password.nfc().collect());
    let mut master = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<Sha256>(pw.as_bytes(), &salt, iter.max(1), master.as_mut());
    let auth_key = hkdf(master.as_ref(), "biopass/auth");
    let wrap_key = hkdf(master.as_ref(), "biopass/wrap");
    Ok(DerivedKeys { auth: Zeroizing::new(b64(auth_key.as_ref())), wrap_key })
}

/// `b64(iv[12] || AES-256-GCM(key, plain, aad))`
pub fn seal(key: &[u8; 32], plain: &[u8], aad: &str) -> String {
    let cipher = Aes256Gcm::new(key.into());
    let iv = random_bytes::<12>();
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), Payload { msg: plain, aad: aad.as_bytes() })
        .expect("chiffrement AES-GCM");
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    b64(&out)
}

pub fn open(key: &[u8; 32], data_b64: &str, aad: &str) -> Result<Zeroizing<Vec<u8>>, Error> {
    let raw = unb64(data_b64)?;
    if raw.len() < 12 + 16 {
        return Err(Error::Other("Donnée chiffrée trop courte".into()));
    }
    let cipher = Aes256Gcm::new(key.into());
    cipher
        .decrypt(Nonce::from_slice(&raw[..12]), Payload { msg: &raw[12..], aad: aad.as_bytes() })
        .map(Zeroizing::new)
        .map_err(|_| Error::Other("Déchiffrement impossible".into()))
}

pub fn wrap_vault_key(wrap_key: &[u8; 32], raw: &[u8; 32]) -> String {
    seal(wrap_key, raw, "biopass/vaultkey")
}

pub fn unwrap_vault_key(wrap_key: &[u8; 32], wrapped: &str) -> Result<Key, Error> {
    let plain = open(wrap_key, wrapped, "biopass/vaultkey").map_err(|_| Error::BadPassword)?;
    if plain.len() != 32 {
        return Err(Error::BadPassword);
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&plain);
    Ok(key)
}

/// Clés d'un nouveau compte (ou d'un changement de mot de passe si `raw` est fourni).
pub struct AccountKeys {
    pub salt: String,
    pub iter: u32,
    pub auth: Zeroizing<String>,
    pub wrapped: String,
    pub raw: Key,
}

pub fn make_account_keys(password: &str, raw: Option<Key>, iter: u32) -> Result<AccountKeys, Error> {
    let raw = raw.unwrap_or_else(|| Zeroizing::new(random_bytes::<32>()));
    let salt = b64(&random_bytes::<16>());
    let k = derive_keys(password, &salt, iter)?;
    let wrapped = wrap_vault_key(&k.wrap_key, &raw);
    Ok(AccountKeys { salt, iter, auth: k.auth, wrapped, raw })
}

fn item_aad(id: &str) -> String {
    format!("biopass/item/{id}")
}

pub fn encrypt_item(vault_key: &[u8; 32], id: &str, obj: &Map<String, Value>) -> String {
    let json = Zeroizing::new(serde_json::to_vec(obj).expect("sérialisation JSON"));
    seal(vault_key, &json, &item_aad(id))
}

pub fn decrypt_item(vault_key: &[u8; 32], id: &str, enc: &str) -> Result<Map<String, Value>, Error> {
    let plain = open(vault_key, enc, &item_aad(id))?;
    match serde_json::from_slice(&plain) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(Error::Other("Entrée illisible".into())),
    }
}

/// Efface (au mieux) les chaînes contenues dans une valeur JSON déchiffrée.
pub fn wipe_value(v: &mut Value) {
    match v {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe_value),
        Value::Object(m) => wipe_map(m),
        _ => {}
    }
}

pub fn wipe_map(m: &mut Map<String, Value>) {
    m.values_mut().for_each(wipe_value);
    m.clear();
}
