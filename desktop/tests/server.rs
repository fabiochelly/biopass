//! Tests d'intégration contre un vrai serveur PHP (ignorés par défaut).
//!
//!   BIOPASS_TEST_SERVER='http://127.0.0.1:8781/?k=cle-test' cargo test --test server -- --ignored --test-threads=1
//!
//! `BIOPASS_INTEROP_FILE` : fichier JSON d'échange avec le script node (interopérabilité core.js).

use std::path::PathBuf;

use biopass::model::Form;
use biopass::vault::{Change, Storage, Vault};
use biopass::Error;
use serde_json::{json, Map, Value};

fn server() -> String {
    std::env::var("BIOPASS_TEST_SERVER").unwrap_or_else(|_| "http://127.0.0.1:8781".into())
}

fn tmp_storage(name: &str) -> Storage {
    let dir = std::env::temp_dir().join(format!("biopass-test-{}", biopass::crypto::new_id()));
    Storage::new(dir.join(name).join("cache.json"))
}

fn obj(v: Value) -> Map<String, Value> {
    serde_json::from_value(v).unwrap()
}

fn interop_file() -> Option<PathBuf> {
    std::env::var_os("BIOPASS_INTEROP_FILE").map(PathBuf::from)
}

#[test]
#[ignore]
fn scenario_complet() {
    let server = server();
    let user = format!("rust{}", biopass::now_ms());

    // --- clé d'accès : sans clé valide, le serveur répond 404 → message clair
    let addr = biopass::api::parse_server(&server).unwrap();
    if !addr.key.is_empty() {
        for bad in [addr.base.clone(), format!("{}/?k=mauvaise-cle", addr.base)] {
            let e = biopass::vault::remote_login(&bad, "personne", "x").err().expect("doit échouer");
            assert_eq!(e.status(), 404, "{bad}");
            assert_eq!(e.to_string(), "Serveur introuvable ou clé d'accès incorrecte");
            let mut v = Vault::load(tmp_storage("cle"));
            assert_eq!(v.register(&bad, "personne", "motdepasse", "famille").unwrap_err().status(), 404);
        }
        println!("OK : clé d'accès exigée (404 sans clé ou avec une mauvaise clé)");
    }

    // --- inscription
    let mut a = Vault::load(tmp_storage("a"));
    let e = a.register(&server, &user, "pw", "mauvais").unwrap_err();
    assert_eq!(e.status(), 403, "{e}");
    assert!(e.to_string().contains("incorrect"));
    a.register(&server, &user, "motdepasse-1", "famille").unwrap();
    assert!(a.online && a.unlocked());

    // --- deux entrées
    let ids = a
        .save(&[
            Change::Upsert { id: None, data: obj(json!({"type": "login", "name": "GitHub", "username": "fab", "password": "mdp-github-x1", "uris": ["github.com"]})) },
            Change::Upsert { id: None, data: obj(json!({"name": "Banque", "password": "mdp-banque-x2", "futur": {"inconnu": true}})) },
        ])
        .unwrap();
    let (id1, id2) = (ids[0].clone(), ids[1].clone());
    assert_eq!(a.items.len(), 2);
    assert!(a.items[&id1].data["created"].as_u64().unwrap() > 0);

    // --- deuxième appareil (identifiant en majuscules → normalisé)
    let sb = tmp_storage("b");
    let mut b = Vault::load(sb.clone());
    b.login(&server, &user.to_uppercase(), "motdepasse-1").unwrap();
    assert_eq!(b.items[&id1].str("password"), "mdp-github-x1");
    assert_eq!(b.items[&id2].data["futur"], json!({"inconnu": true}));

    // Le cache ne contient que du chiffré, jamais le token ; permissions 0600.
    let raw = std::fs::read_to_string(&sb.path).unwrap();
    for secret in ["mdp-github-x1", "mdp-banque-x2", "GitHub", "Banque", "motdepasse", b.api.token.as_deref().unwrap()] {
        assert!(!raw.contains(secret), "le cache contient « {secret} »");
    }
    let cached: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(cached["profile"]["user"], user.as_str());
    // Le profil stocke la forme normServer (clé comprise).
    assert_eq!(cached["profile"]["server"], biopass::api::norm_server(&server).unwrap().as_str());
    assert_eq!(cached["vault"]["items"].as_object().unwrap().len(), 2);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&sb.path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // --- modification sur A, conflit sur B
    let mut f = Form::from_item(&a.items[&id1].data);
    f.password = "nouveau".into();
    let data = biopass::model::with_history(&a.items[&id1].data, f.apply(&a.items[&id1].data), biopass::now_ms());
    a.save(&[Change::Upsert { id: Some(id1.clone()), data }]).unwrap();
    assert_eq!(biopass::model::history(&a.items[&id1].data)[0].0, "mdp-github-x1");

    let mut stale = b.items[&id1].data.clone();
    stale.insert("password".into(), json!("conflit"));
    let e = b.save(&[Change::Upsert { id: Some(id1.clone()), data: stale }]).unwrap_err();
    assert!(matches!(&e, Error::Http { status: 409, conflicts, .. } if conflicts == &vec![id1.clone()]), "{e:?}");
    assert_eq!(b.items[&id1].str("password"), "nouveau", "B s'est resynchronisé");

    // --- suppression sur B, visible sur A
    b.save(&[Change::Delete(id2.clone())]).unwrap();
    assert!(a.sync().unwrap());
    assert!(!a.items.contains_key(&id2));
    assert_eq!(a.cache.rev, b.cache.rev);
    assert!(!a.sync().unwrap(), "rien de nouveau");

    // --- mauvais mot de passe, déverrouillage
    b.lock();
    assert!(!b.unlocked() && b.items.is_empty());
    assert_eq!(b.unlock("faux").unwrap_err().status(), 401);
    b.unlock("motdepasse-1").unwrap();
    assert_eq!(b.items[&id1].str("password"), "nouveau");

    // --- changement de mot de passe sur B → session de A expirée
    b.change_password("motdepasse-1", "motdepasse-2").unwrap();
    assert_eq!(a.sync().unwrap_err().status(), 401);
    a.lock();
    assert_eq!(a.unlock("motdepasse-1").unwrap_err().status(), 401);
    a.unlock("motdepasse-2").unwrap();
    assert_eq!(a.items[&id1].str("password"), "nouveau");

    // --- hors ligne : cache local seulement, lecture seule
    let mut c = Vault::load(sb.clone());
    c.profile.as_mut().unwrap().server = "http://127.0.0.1:1".into();
    c.api = biopass::api::Api::new("http://127.0.0.1:1");
    c.unlock("motdepasse-2").unwrap();
    assert!(!c.online && !c.has_token());
    assert_eq!(c.items[&id1].str("password"), "nouveau");
    assert!(c.save(&[Change::Delete(id1.clone())]).unwrap_err().to_string().contains("Hors ligne"));
    assert_eq!(c.unlock("motdepasse-1").unwrap_err(), Error::BadPassword);

    // --- reconnexion avec l'auth gardée en mémoire après un déverrouillage hors ligne
    let mut d = Vault::load(sb.clone());
    let real = d.profile.clone().unwrap();
    d.profile.as_mut().unwrap().server = "http://127.0.0.1:1".into();
    d.api = biopass::api::Api::new("http://127.0.0.1:1");
    d.unlock("motdepasse-2").unwrap();
    assert!(!d.online);
    d.api = biopass::api::Api::new(&real.server);
    let s = biopass::vault::remote_reconnect(&real.server, &real.user, d.auth().unwrap()).unwrap();
    d.apply_reconnect(s).unwrap();
    assert!(d.online && d.has_token());
    d.sync().unwrap();

    // --- session persistante : reprise sans mot de passe puis login(auth) pour obtenir un token
    let store = biopass::session::SessionStore::new(sb.path.with_file_name("session.json"));
    store.save(&d.session_file(None).unwrap()).unwrap();
    let mut e = Vault::load(sb.clone());
    e.resume(&store.load(biopass::now_ms()).unwrap()).unwrap();
    assert!(!e.has_token());
    assert_eq!(e.items[&id1].str("password"), "nouveau");
    let p = e.profile.clone().unwrap();
    let s = biopass::vault::remote_reconnect(&p.server, &p.user, e.auth().unwrap()).unwrap();
    e.apply_reconnect(s).unwrap();
    e.sync().unwrap();
    assert!(e.online && e.has_token());
    // Mot de passe changé ailleurs → l'auth conservée est refusée (401).
    b.change_password("motdepasse-2", "motdepasse-3").unwrap();
    let e2 = biopass::vault::remote_reconnect(&p.server, &p.user, e.auth().unwrap()).unwrap_err();
    assert_eq!(e2.status(), 401);
    b.change_password("motdepasse-3", "motdepasse-2").unwrap();
    println!("OK : reprise de session sans mot de passe, 401 après changement de mot de passe");

    // --- compte laissé pour le test d'interopérabilité avec core.js
    if let Some(path) = interop_file() {
        let info = json!({"server": server, "user": user, "password": "motdepasse-2", "rustId": id1});
        std::fs::write(path, info.to_string()).unwrap();
    }
    println!("OK : scénario complet ({user})");
}

/// Étape 2 de l'interopérabilité : lit une entrée créée par core.js, la modifie (champs inconnus conservés).
#[test]
#[ignore]
fn interop_lecture_js() {
    let Some(path) = interop_file() else {
        eprintln!("BIOPASS_INTEROP_FILE absent : test ignoré");
        return;
    };
    let info: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let Some(js_id) = info["jsId"].as_str().map(str::to_string) else {
        eprintln!("pas encore d'entrée créée par core.js (lancer le script node d'abord) : test ignoré");
        return;
    };
    let mut v = Vault::load(tmp_storage("interop"));
    v.login(info["server"].as_str().unwrap(), info["user"].as_str().unwrap(), info["password"].as_str().unwrap()).unwrap();
    let it = &v.items[&js_id];
    assert_eq!(it.name(), "Créée par core.js ✓");
    assert_eq!(it.str("password"), "js-pw");
    assert_eq!(it.data["futur"], json!({"x": [1, 2, 3]}));
    assert_eq!(it.data["fields"][0]["value"], "1234");
    let created = it.data["created"].clone();

    let mut f = Form::from_item(&it.data);
    f.password = "rust-pw".into();
    f.uris = "exemple.fr\nhttps://www.exemple.fr/connexion".into();
    let data = biopass::model::with_history(&it.data, f.apply(&it.data), biopass::now_ms());
    v.save(&[Change::Upsert { id: Some(js_id.clone()), data }]).unwrap();
    let it = &v.items[&js_id];
    assert_eq!(it.str("password"), "rust-pw");
    assert_eq!(it.data["futur"], json!({"x": [1, 2, 3]}));
    assert_eq!(it.data["created"], created);
    println!("OK : entrée core.js lue et modifiée par Rust");
}
