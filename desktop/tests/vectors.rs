//! Tests contre tools/test-vectors.json (générés par core.js).

use biopass::crypto::{self, b64, unb64};
use biopass::model::Form;
use biopass::util::{base_domain, generate_password, host_of, matches_url, search, totp, GenOptions};
use serde_json::{json, Map, Value};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/test-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("lecture test-vectors.json")).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap()
}

#[test]
fn derive_unwrap_decrypt() {
    let v = vectors();
    let k = crypto::derive_keys(s(&v, "password"), s(&v, "salt"), v["iter"].as_u64().unwrap() as u32).unwrap();
    assert_eq!(k.auth.as_str(), s(&v, "auth"), "auth identique à core.js");

    let raw = crypto::unwrap_vault_key(&k.wrap_key, s(&v, "wrapped")).unwrap();
    assert_eq!(b64(raw.as_ref()), s(&v, "vaultKeyRawB64"));

    let item = crypto::decrypt_item(&raw, s(&v, "itemId"), s(&v, "itemEnc")).unwrap();
    assert_eq!(Value::Object(item), v["item"]);

    // L'AAD lie le chiffré à l'id : un autre id doit échouer.
    assert!(crypto::decrypt_item(&raw, "ffffffffffffffffffffffffffffffff", s(&v, "itemEnc")).is_err());
    // Mauvais mot de passe → BadPassword.
    let bad = crypto::derive_keys("creme brulee 42!", s(&v, "salt"), 1000).unwrap();
    assert_eq!(crypto::unwrap_vault_key(&bad.wrap_key, s(&v, "wrapped")).unwrap_err(), biopass::Error::BadPassword);
}

#[test]
fn nfc_normalisation() {
    // « Crème » décomposé (e + accent combinant) doit donner la même auth.
    let v = vectors();
    let nfd = s(&v, "password").replace('è', "e\u{300}").replace('û', "u\u{302}").replace('é', "e\u{301}");
    assert_ne!(nfd, s(&v, "password"));
    let k = crypto::derive_keys(&nfd, s(&v, "salt"), 600_000).unwrap();
    assert_eq!(k.auth.as_str(), s(&v, "auth"));
}

#[test]
fn roundtrip_rust() {
    let acc = crypto::make_account_keys("motdepasse", None, 1000).unwrap();
    assert_eq!(unb64(&acc.wrapped).unwrap().len(), 60);
    let k = crypto::derive_keys("motdepasse", &acc.salt, 1000).unwrap();
    assert_eq!(k.auth, acc.auth);
    let raw = crypto::unwrap_vault_key(&k.wrap_key, &acc.wrapped).unwrap();
    assert_eq!(raw, acc.raw);

    let id = crypto::new_id();
    assert_eq!(id.len(), 32);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    let obj: Map<String, Value> = serde_json::from_value(json!({"name": "Été", "x": {"inconnu": [1, 2]}})).unwrap();
    let enc = crypto::encrypt_item(&raw, &id, &obj);
    assert_eq!(crypto::decrypt_item(&raw, &id, &enc).unwrap(), obj);
    // IV aléatoire : deux chiffrements diffèrent.
    assert_ne!(enc, crypto::encrypt_item(&raw, &id, &obj));
}

#[test]
fn totp_vectors() {
    let v = vectors();
    for t in v["totp"].as_array().unwrap() {
        let r = totp(s(t, "secret"), t["timeMs"].as_u64().unwrap()).unwrap();
        assert_eq!(r.code, s(t, "code"), "{}", s(t, "secret"));
    }
    // RFC 6238 (SHA-1, 8 chiffres, T=59 s)
    let rfc = "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8";
    assert_eq!(totp(rfc, 59_000).unwrap().code, "94287082");
    let r = totp("JBSWY3DPEHPK3PXP", 1_700_000_000_000).unwrap();
    assert_eq!((r.remaining, r.period), (10, 30));
    assert!(totp("pas du base32 !", 0).is_none());
}

#[test]
fn domains() {
    let v = vectors();
    for pair in v["baseDomain"].as_array().unwrap() {
        assert_eq!(base_domain(pair[0].as_str().unwrap()), pair[1].as_str().unwrap());
    }
    assert_eq!(host_of("github.com/login"), "github.com");
    assert_eq!(host_of("HTTPS://Accounts.Google.COM/x"), "accounts.google.com");
    assert_eq!(host_of(""), "");
    let item: Map<String, Value> = serde_json::from_value(json!({"uris": ["github.com"]})).unwrap();
    assert!(matches_url(&item, "https://gist.github.com/abc"));
    assert!(!matches_url(&item, "https://gitlab.com"));
}

#[test]
fn search_vectors() {
    use biopass::util::{fold, SearchFields};
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/search-vectors.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("lecture search-vectors.json")).unwrap();
    for pair in v["fold"].as_array().unwrap() {
        assert_eq!(fold(pair[0].as_str().unwrap()), pair[1].as_str().unwrap());
    }
    // `_fz` est un cache interne de core.js présent dans le fichier : ignoré, recalculé ici.
    let items: Vec<(String, SearchFields)> = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|it| {
            let mut m: Map<String, Value> = serde_json::from_value(it.clone()).unwrap();
            m.remove("_fz");
            (m["name"].as_str().unwrap().to_string(), SearchFields::new(&m))
        })
        .collect();
    let mut n = 0;
    for case in v["vectors"].as_array().unwrap() {
        let q = s(case, "query");
        let expected: Vec<&str> = case["results"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        let got = search(items.iter().map(|(name, f)| (f, name.as_str())), q);
        assert_eq!(got, expected, "requête {q:?}");
        n += 1;
    }
    assert!(n >= 35, "{n} requêtes seulement");
}

#[test]
fn fuzzy_details() {
    use biopass::util::{fold, term_score};
    let u = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    assert_eq!(fold("Œuvre Æther"), "oeuvre aether");
    assert_eq!(fold("ÉCOLE Noël"), "ecole noel");
    assert_eq!(term_score(&u("git"), &u("github")), 100);
    assert_eq!(term_score(&u("hub"), &u("git-hub")), 90);
    assert_eq!(term_score(&u("hub"), &u("github")), 70);
    // lettres dans l'ordre (valeurs vérifiées avec core.js) : round(30 + 30×4/6) = 50 ;
    // round(30 + 30×3/5) = 48 ; round(30 + 30×3/4) = round(52,5) = 53 (demi vers +∞)
    assert_eq!(term_score(&u("gthb"), &u("github")), 50);
    assert_eq!(term_score(&u("gml"), &u("gmail")), 48);
    assert_eq!(term_score(&u("abc"), &u("abxc")), 53);
    // fautes de frappe (≥ 4 lettres) : transposition, préfixe d'un mot plus long
    assert_eq!(term_score(&u("githbu"), &u("github")), 40);
    assert_eq!(term_score(&u("infomanaik"), &u("infomaniak ssh")), 40);
    assert_eq!(term_score(&u("zz"), &u("github")), 0);
}

#[test]
fn generator() {
    for len in [4, 12, 20, 64] {
        let pw = generate_password(&GenOptions { length: len, ..Default::default() });
        assert_eq!(pw.chars().count(), len);
        assert!(pw.chars().any(|c| c.is_ascii_digit()));
        assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
    }
    let pw = generate_password(&GenOptions { length: 30, lower: false, upper: false, digits: true, symbols: false });
    assert!(pw.chars().all(|c| "23456789".contains(c)));
}

#[test]
fn form_preserves_unknown_fields() {
    let base: Map<String, Value> = serde_json::from_value(json!({
        "type": "login", "name": "A", "password": "x", "created": 5,
        "fields": [{"name": "PIN", "value": "1234", "hidden": true}], "futur": {"a": 1}
    }))
    .unwrap();
    let mut f = Form::from_item(&base);
    f.password = "nouveau".into();
    f.uris = " github.com \n\nhttps://x.fr\n".into();
    let m = f.apply(&base);
    assert_eq!(m["password"], "nouveau");
    assert_eq!(m["uris"], json!(["github.com", "https://x.fr"]));
    assert_eq!(m["futur"], json!({"a": 1}));
    assert_eq!(m["fields"], base["fields"]);
    assert_eq!(m["created"], 5);
}

#[test]
fn password_history() {
    use biopass::model::{history, with_history};
    let prev: Map<String, Value> = serde_json::from_value(json!({
        "password": "v3",
        "history": [{"password": "v2", "date": 2}, {"password": "v1", "date": 1}]
    }))
    .unwrap();
    // Mot de passe inchangé → pas d'historique ajouté.
    let same = with_history(&prev, prev.clone(), 99);
    assert_eq!(same, prev);
    // Changement → ancien en tête.
    let mut next = prev.clone();
    next.insert("password".into(), json!("v4"));
    let out = with_history(&prev, next, 99);
    assert_eq!(history(&out), vec![("v3", 99), ("v2", 2), ("v1", 1)]);
    // Création (pas d'ancien mot de passe) → rien.
    let created = with_history(&Map::new(), serde_json::from_value(json!({"password": "x"})).unwrap(), 5);
    assert!(created.get("history").is_none());
    // Limite de 10.
    let mut cur: Map<String, Value> = serde_json::from_value(json!({"password": "p0"})).unwrap();
    for i in 1..=15 {
        let mut n = cur.clone();
        n.insert("password".into(), json!(format!("p{i}")));
        cur = with_history(&cur, n, i);
    }
    let h = history(&cur);
    assert_eq!(h.len(), 10);
    assert_eq!(h[0], ("p14", 15));
}

#[test]
fn server_address() {
    use biopass::api::{display_server, norm_server, parse_server, web_url, Api};
    let p = |s: &str| {
        let a = parse_server(s).unwrap();
        (a.base, a.key)
    };
    // Cas de core.js
    assert_eq!(p("https://example.com/biopass/?k=ab-12"), ("https://example.com/biopass".into(), "ab-12".into()));
    assert_eq!(p("example.com/biopass"), ("https://example.com/biopass".into(), "".into()));
    assert_eq!(p("https://x.fr/biopass/index.html?k=1"), ("https://x.fr/biopass".into(), "1".into()));
    // Autres
    assert_eq!(p(" HTTP://Exemple.FR:8080/api.php "), ("http://exemple.fr:8080".into(), "".into()));
    assert_eq!(p("https://x.fr///"), ("https://x.fr".into(), "".into()));
    assert_eq!(p(""), (".".into(), "".into()));
    assert!(parse_server("https://exa mple.fr").is_err());
    assert_eq!(norm_server("example.com/biopass/?k=a%20b%26c&x=1").unwrap(), "https://example.com/biopass/?k=a%20b%26c");
    assert_eq!(norm_server("https://x.fr/biopass/").unwrap(), "https://x.fr/biopass");
    assert_eq!(web_url("https://x.fr/biopass/?k=1").unwrap(), "https://x.fr/biopass/?k=1");
    assert_eq!(web_url("https://x.fr/biopass").unwrap(), "https://x.fr/biopass/");
    // Aller-retour stable et clé jamais affichée
    let n = norm_server("https://example.com/biopass/?k=GUID-42").unwrap();
    assert_eq!(norm_server(&n).unwrap(), n);
    assert_eq!(display_server(&n), "https://example.com/biopass");
    let api = Api::new(&n);
    assert_eq!((api.base.as_str(), api.key.as_str(), api.server.as_str()), ("https://example.com/biopass", "GUID-42", n.as_str()));
}

// PNG d'exemple produits par un encodeur indépendant (Python zlib) :
// 48×48 RGBA, moitié gauche rouge opaque, moitié droite bleu à 50 % ; 2×1 en palette avec tRNS.
const ICON_RGBA48: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAARElEQVR4nO3PMQ0AAAgEsZeOc0ACC1uTOwFNJ/35Vq8DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFwfFbSzYuyu1hcAAAAASUVORK5CYII=";
const ICON_PALETTE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAMAAADD/I+4AAAABlBMVEUA/wD///9vvVhRAAAAAnRSTlP/AOW3MEoAAAALSURBVHicY2BgBAAABAACv3o/SgAAAABJRU5ErkJggg==";

#[test]
fn icon_decoding() {
    use biopass::icon::decode_icon;
    let img = decode_icon(ICON_RGBA48).expect("icône 48×48");
    assert_eq!((img.width, img.height, img.pixels.len()), (48, 48, 48 * 48 * 4));
    let px = |x: usize, y: usize| &img.pixels[(y * 48 + x) * 4..(y * 48 + x) * 4 + 4];
    assert_eq!(px(0, 0), [255, 0, 0, 255]);
    assert_eq!(px(47, 30), [0, 0, 255, 128]);

    let pal = decode_icon(ICON_PALETTE).expect("palette");
    assert_eq!((pal.width, pal.height), (2, 1));
    assert_eq!(pal.pixels, vec![0, 255, 0, 255, 255, 255, 255, 0]);

    for bad in [
        "",
        "pas une url",
        "data:image/jpeg;base64,/9j/4AAQ",
        "data:image/png;base64,!!!",
        "data:image/png,iVBORw0KGgo",
        &ICON_RGBA48[..80], // tronquée
    ] {
        assert!(decode_icon(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn icon_kept_or_reset_on_edit() {
    use biopass::icon::{icon_host, icon_key, reset_icon_if_site_changed};
    // icon_host : mêmes résultats que iconHost de core.js
    let host = |uris: Value| icon_host(&serde_json::from_value(json!({ "uris": uris })).unwrap());
    assert_eq!(host(json!(["https://www.github.com/login"])), "github.com");
    assert_eq!(host(json!(["github.com"])), "github.com");
    assert_eq!(host(json!(["android://x", "ssh://xyzw.vps.infomaniak.com"])), "xyzw.vps.infomaniak.com");
    assert_eq!(host(json!(["https://192.168.1.1"])), "");
    assert_eq!(host(json!(["http://localhost:8080"])), "");
    assert_eq!(host(json!(["mailto:a@b.fr", "HTTPS://WWW.Exemple.FR/x"])), "exemple.fr");
    assert_eq!(host(json!([])), "");

    let base: Map<String, Value> = serde_json::from_value(json!({
        "name": "GitHub", "password": "x", "uris": ["https://github.com/login"], "icon": ICON_RGBA48, "iconTry": 123
    }))
    .unwrap();
    assert!(icon_key(&base).is_some());
    // Modification sans changer de site : icon et iconTry conservés tels quels.
    let mut f = Form::from_item(&base);
    f.password = "nouveau".into();
    f.uris = "https://www.github.com/settings".into();
    let mut next = f.apply(&base);
    reset_icon_if_site_changed(&base, &mut next);
    assert_eq!(next["icon"], ICON_RGBA48);
    assert_eq!(next["iconTry"], 123);
    // Changement de site : icon et iconTry supprimés.
    f.uris = "gitlab.com".into();
    let mut next = f.apply(&base);
    reset_icon_if_site_changed(&base, &mut next);
    assert!(next.get("icon").is_none() && next.get("iconTry").is_none());
    assert_eq!(icon_key(&next), None);
}

#[test]
fn entry_kinds() {
    use biopass::icon::{entry_kind, Kind::*};
    // Résultats de entryKind (core.js) sur les mêmes entrées.
    let cases = [
        (json!({"name":"Box","uris":["http://192.168.1.1"]}), Some(Network)),
        (json!({"name":"NAS","uris":["https://nas.local:5001"]}), Some(Network)),
        (json!({"name":"Serveur perso","uris":["ssh://xyzw.vps.infomaniak.com"]}), Some(Terminal)),
        (json!({"name":"Wi-Fi maison"}), Some(Wifi)),
        (json!({"name":"Visa","fields":[{"name":"Numéro"},{"name":"Code"}]}), Some(Card)),
        (json!({"name":"Clé API OpenAI"}), Some(Key)),
        (json!({"name":"Ma banque","uris":["androidapp://com.banque"]}), Some(App)),
        (json!({"name":"Mémo","type":"note","uris":["https://x.fr"]}), Some(Note)),
        (json!({"name":"GitHub","uris":["https://github.com"]}), None),
        (json!({"name":"Routeur","uris":["http://[::1]:8080"]}), Some(Network)),
        (json!({"name":"Mon compte","uris":["https://x.fr"],"fields":[{"name":"numero client"},{"name":"Expiration"}]}), Some(Card)),
        (json!({"name":"cb","uris":["https://x.fr"]}), Some(Card)),
        (json!({"name":"keyboard","uris":["https://x.fr"]}), None),
        (json!({"name":"licence Office","uris":["https://office.com"]}), Some(Key)),
        (json!({"name":"Freebox","uris":["https://free.fr"]}), None),
        (json!({"name":"Ma box","uris":["https://free.fr"]}), Some(Wifi)),
        (json!({"name":"serveurs","uris":["https://x.fr"]}), Some(Terminal)),
        (json!({"name":"deadbeef","uris":["https://cafe.de"]}), None),
        (json!({"name":"x","uris":["https://localhost"]}), Some(Network)),
        (json!({"name":"x","uris":["https://a.internal"]}), Some(Network)),
        (json!({"name":"x","uris":["https://ab12.fe"]}), None),
        (json!({"name":"x","uris":["https://cafe1.be"]}), None),
        (json!({"name":"x","uris":["http://box.localdomain"]}), Some(Network)),
        (json!({"name":"x","uris":["http://[::1]"]}), Some(Network)),
        (json!({"name":"x","uris":["http://10.0.0.254:8080/admin"]}), Some(Network)),
        (json!({"name":"x","uris":["http://1.2.3.4.5"]}), None),
        (json!({"name":"x","uris":["androidapp://a","https://b.fr"]}), None),
    ];
    for (it, expected) in cases {
        let m: Map<String, Value> = serde_json::from_value(it.clone()).unwrap();
        assert_eq!(entry_kind(&m), expected, "{it}");
    }
}
