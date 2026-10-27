//! Réglages et session persistante (« Rester déverrouillé ») : expiration, effacement, reprise.

use biopass::crypto::{self, b64};
use biopass::session::{SessionFile, SessionStore, Settings, StayUnlocked};
use biopass::vault::{Opened, Storage, Vault};
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

fn tmp_dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("biopass-session-{}", crypto::new_id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Cache local avec un profil et deux entrées chiffrées par `key`.
fn vault_with_items(dir: &std::path::Path, key: &[u8; 32]) -> Storage {
    let item = |name: &str| -> Map<String, Value> { serde_json::from_value(json!({"name": name, "password": "pw-".to_string() + name})).unwrap() };
    let (id1, id2) = (crypto::new_id(), crypto::new_id());
    let cache = json!({
        "profile": {"server": "https://x.fr/biopass/?k=cle", "user": "camille", "salt": "AAAA", "iter": 600000, "wrapped": "AAAA"},
        "vault": {"rev": 3, "items": {
            id1.clone(): {"rev": 2, "enc": crypto::encrypt_item(key, &id1, &item("GitHub"))},
            id2.clone(): {"rev": 3, "enc": crypto::encrypt_item(key, &id2, &item("Banque"))}
        }}
    });
    let path = dir.join("cache.json");
    std::fs::write(&path, cache.to_string()).unwrap();
    Storage::new(path)
}

fn session_of(v: &Vault, expires: Option<u64>) -> SessionFile {
    v.session_file(expires).expect("session")
}

#[test]
fn settings_defaults_and_persistence() {
    let d = tmp_dir();
    let path = d.join("settings.json");
    let s = Settings::load(&path);
    assert_eq!(s.stay_unlocked, StayUnlocked::Hours48, "défaut : 48 h");
    let s2 = Settings { stay_unlocked: StayUnlocked::Always };
    s2.save(&path).unwrap();
    assert_eq!(Settings::load(&path), s2);
    std::fs::write(&path, "pas du json").unwrap();
    assert_eq!(Settings::load(&path), Settings::default());
    // ancien fichier avec le réglage d'effacement du presse-papiers (supprimé) : toujours lisible
    std::fs::write(&path, r#"{"clipboard_clear":"Secs30","stay_unlocked":"Always"}"#).unwrap();
    assert_eq!(Settings::load(&path), s2);
    assert_eq!(StayUnlocked::Hours48.deadline(1_000), Some(1_000 + 48 * 3_600_000));
    assert_eq!(StayUnlocked::Mins5.deadline(0), Some(300_000));
    assert_eq!(StayUnlocked::Always.deadline(1_000), None);
}

#[test]
fn session_store_expiry_and_clear() {
    let d = tmp_dir();
    let store = SessionStore::new(d.join("session.json"));
    let s = SessionFile { server: "s".into(), user: "u".into(), key: b64(&[7u8; 32]), auth: "auth".into(), expires: Some(10_000) };
    store.save(&s).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&store.path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(store.load(9_999).is_some(), "avant l'échéance");
    assert!(store.exists());
    assert!(store.load(10_000).is_none(), "à l'échéance : expirée");
    assert!(!store.exists(), "une session expirée est supprimée");

    // « Toujours » : jamais expirée
    let forever = SessionFile { server: s.server.clone(), user: s.user.clone(), key: s.key.clone(), auth: s.auth.clone(), expires: None };
    store.save(&forever).unwrap();
    assert!(store.load(u64::MAX).is_some());
    // Verrouiller → fichier effacé
    store.clear();
    assert!(!store.exists() && store.load(0).is_none());
    // Fichier corrompu → ignoré et supprimé
    std::fs::write(&store.path, "{").unwrap();
    assert!(store.load(0).is_none() && !store.exists());
}

#[test]
fn resume_without_password() {
    let d = tmp_dir();
    let key = Zeroizing::new(crypto::random_bytes::<32>());
    let storage = vault_with_items(&d, &key);
    let store = SessionStore::new(d.join("session.json"));

    // Déverrouillage (ici sans serveur) puis enregistrement de la session.
    let mut v = Vault::load(storage.clone());
    v.apply_open(Opened { server: "https://x.fr/biopass/?k=cle".into(), session: None, key: key.clone(), auth: Zeroizing::new("AUTH-B64".into()) })
        .unwrap();
    assert_eq!(v.items.len(), 2);
    store.save(&session_of(&v, StayUnlocked::Hours48.deadline(1_000))).unwrap();
    drop(v);

    // « Relance » de l'application : reprise sans mot de passe.
    let mut v2 = Vault::load(storage.clone());
    let s = store.load(2_000).expect("session valide");
    v2.resume(&s).unwrap();
    assert!(v2.unlocked() && !v2.has_token() && !v2.online, "reprise hors ligne, token à obtenir avec auth");
    assert_eq!(v2.auth(), Some("AUTH-B64"));
    assert_eq!(v2.api.key, "cle", "clé d'accès du serveur reprise");
    let mut names: Vec<&str> = v2.items.values().map(|i| i.name()).collect();
    names.sort();
    assert_eq!(names, ["Banque", "GitHub"]);

    // Après l'échéance : plus de reprise.
    assert!(store.load(1_000 + 48 * 3_600_000).is_none());

    // Mauvaise clé → refusée, coffre verrouillé.
    let bad = SessionFile { server: s.server.clone(), user: s.user.clone(), key: b64(&[1u8; 32]), auth: "x".into(), expires: None };
    let mut v3 = Vault::load(storage.clone());
    assert!(v3.resume(&bad).is_err());
    assert!(!v3.unlocked() && v3.items.is_empty());
    // Session d'un autre compte → refusée.
    let other = SessionFile { user: "autre".into(), key: s.key.clone(), auth: "x".into(), server: s.server.clone(), expires: None };
    assert!(Vault::load(storage).resume(&other).is_err());
}
