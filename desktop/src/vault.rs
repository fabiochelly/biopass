//! Coffre : profil, cache local chiffré, session, synchronisation — miroir de la classe `Vault` de core.js.
//!
//! Les opérations réseau / PBKDF2 sont des fonctions libres bloquantes (`remote_*`) qui ne touchent
//! pas au coffre : l'UI les exécute dans un thread puis applique le résultat (`apply_*`) sur son
//! thread. Les méthodes bloquantes `login`, `unlock`, `sync`, `save`… composent les deux (tests, CLI).

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use crate::api::{Api, Session, SyncResponse};
use crate::crypto::{self, Key};
use crate::util::{get_bool, get_str, SearchFields};
use crate::{now_ms, Error};

// ------------------------------------------------------------------ stockage local

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub server: String,
    pub user: String,
    pub salt: String,
    pub iter: u32,
    pub wrapped: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CacheItem {
    pub rev: u64,
    pub enc: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VaultCache {
    pub rev: u64,
    pub items: BTreeMap<String, CacheItem>,
}

#[derive(Default, Serialize, Deserialize)]
struct CacheFile {
    #[serde(default)]
    profile: Option<Profile>,
    #[serde(default)]
    vault: VaultCache,
}

/// Cache local : `{profile:{server,user,salt,iter,wrapped}, vault:{rev, items:{id:{rev,enc}}}}`.
/// Uniquement des données chiffrées ; jamais le token.
#[derive(Debug, Clone)]
pub struct Storage {
    pub path: PathBuf,
}

impl Storage {
    pub fn new(path: impl Into<PathBuf>) -> Storage {
        Storage { path: path.into() }
    }

    /// `$BIOPASS_DATA_DIR/cache.json` sinon `<data_dir>/biopass/cache.json`.
    pub fn default_path() -> PathBuf {
        let dir = std::env::var_os("BIOPASS_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::data_dir().map(|d| d.join("biopass")))
            .unwrap_or_else(|| PathBuf::from("."));
        dir.join("cache.json")
    }

    fn load(&self) -> (Option<Profile>, VaultCache) {
        let f: CacheFile = fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        (f.profile, f.vault)
    }

    /// Écriture atomique (fichier temporaire + fsync + rename), permissions 0600 sous Unix.
    fn save(&self, profile: &Option<Profile>, vault: &VaultCache) -> Result<(), Error> {
        let data = serde_json::to_vec(&json!({ "profile": profile, "vault": vault })).expect("sérialisation JSON");
        write_private(&self.path, &data)
    }
}

/// Écriture atomique (fichier temporaire + fsync + rename), permissions 0600 sous Unix,
/// dossier parent créé en 0700.
pub fn write_private(path: &Path, data: &[u8]) -> Result<(), Error> {
    let err = |e: std::io::Error| Error::Other(format!("Écriture de {} impossible : {e}", path.display()));
    let dir = path.parent().unwrap_or(Path::new("."));
    create_private_dir(dir).map_err(err)?;
    let tmp = path.with_extension(format!("{}.tmp", crate::crypto::new_id()));
    let res = (|| {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res.map_err(err)
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    if dir.as_os_str().is_empty() || dir.is_dir() {
        return Ok(());
    }
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)
}

// ------------------------------------------------------------------ entrées déchiffrées

#[derive(Debug, Clone)]
pub struct Item {
    pub id: String,
    pub rev: u64,
    pub data: Map<String, Value>,
    /// Champs de la recherche approximative (cf. `fuzzyFields`).
    pub fz: SearchFields,
    /// Empreinte de l'icône du site (clé du cache de textures), None sans icône.
    pub icon_key: Option<u64>,
    /// Catégorie (`entryKind`), pour l'avatar des entrées sans icône de site.
    pub kind: Option<crate::icon::Kind>,
}

impl Item {
    pub fn name(&self) -> &str {
        get_str(&self.data, "name")
    }
    pub fn fav(&self) -> bool {
        get_bool(&self.data, "fav")
    }
    pub fn str(&self, k: &str) -> &str {
        get_str(&self.data, k)
    }
}

impl Drop for Item {
    fn drop(&mut self) {
        crypto::wipe_map(&mut self.data);
    }
}

/// Modification à enregistrer : création/modification (`id` None = création) ou suppression.
#[derive(Debug, Clone)]
pub enum Change {
    Upsert { id: Option<String>, data: Map<String, Value> },
    Delete(String),
}

// ------------------------------------------------------------------ opérations distantes (bloquantes)

/// Résultat d'une connexion (login / register / unlock en ligne).
pub struct Opened {
    pub server: String,
    pub session: Option<Session>,
    pub key: Key,
    /// `b64(authKey)` gardé en mémoire pour se reconnecter après un déverrouillage hors ligne.
    pub auth: Zeroizing<String>,
}

pub fn normalize_user(user: &str) -> String {
    user.trim().to_lowercase()
}

/// Première connexion sur cet appareil (ou changement d'utilisateur).
pub fn remote_login(server: &str, user: &str, password: &str) -> Result<Opened, Error> {
    let user = normalize_user(user);
    let api = Api::new(server);
    let pre = api.prelogin(&user)?;
    let k = crypto::derive_keys(password, &pre.salt, pre.iter)?;
    let s = api.login(&user, &k.auth)?;
    let key = crypto::unwrap_vault_key(&k.wrap_key, &s.wrapped)?;
    Ok(Opened { server: server.to_string(), session: Some(s), key, auth: k.auth })
}

pub fn remote_register(server: &str, user: &str, password: &str, code: &str) -> Result<Opened, Error> {
    let user = normalize_user(user);
    let api = Api::new(server);
    let k = crypto::make_account_keys(password, None, crypto::DEFAULT_ITER)?;
    let s = api.register(&user, code, &k.salt, k.iter, &k.auth, &k.wrapped)?;
    Ok(Opened { server: server.to_string(), session: Some(s), key: k.raw, auth: k.auth })
}

/// Déverrouillage : en ligne si possible, sinon depuis le profil en cache (session = None).
pub fn remote_unlock(p: &Profile, password: &str) -> Result<Opened, Error> {
    match remote_login(&p.server, &p.user, password) {
        Err(Error::Offline) => {}
        other => return other,
    }
    let k = crypto::derive_keys(password, &p.salt, p.iter)?;
    let key = crypto::unwrap_vault_key(&k.wrap_key, &p.wrapped)?;
    Ok(Opened { server: p.server.clone(), session: None, key, auth: k.auth })
}

/// Reconnexion après un déverrouillage hors ligne, avec l'`auth` gardée en mémoire.
pub fn remote_reconnect(server: &str, user: &str, auth: &str) -> Result<Session, Error> {
    Api::new(server).login(user, auth)
}

// ------------------------------------------------------------------ coffre

pub struct Vault {
    pub storage: Storage,
    pub profile: Option<Profile>,
    pub cache: VaultCache,
    key: Option<Key>,
    auth: Option<Zeroizing<String>>,
    pub api: Api,
    pub online: bool,
    pub items: BTreeMap<String, Item>,
    /// Nombre d'entrées indéchiffrables ignorées.
    pub undecryptable: usize,
}

impl Vault {
    /// Charge le profil et le cache depuis le disque.
    pub fn load(storage: Storage) -> Vault {
        let (profile, cache) = storage.load();
        let api = Api::new(profile.as_ref().map(|p| p.server.as_str()).unwrap_or("."));
        Vault { storage, profile, cache, key: None, auth: None, api, online: false, items: BTreeMap::new(), undecryptable: 0 }
    }

    pub fn unlocked(&self) -> bool {
        self.key.is_some()
    }

    pub fn has_token(&self) -> bool {
        self.api.token.is_some()
    }

    pub fn auth(&self) -> Option<&str> {
        self.auth.as_ref().map(|a| a.as_str())
    }

    fn persist(&self) -> Result<(), Error> {
        self.storage.save(&self.profile, &self.cache)
    }

    fn new_profile(&mut self, server: &str, s: &Session) -> Result<(), Error> {
        let same = self.profile.as_ref().is_some_and(|p| p.server == server && p.user == s.user);
        self.profile = Some(Profile {
            server: server.to_string(),
            user: s.user.clone(),
            salt: s.salt.clone(),
            iter: s.iter,
            wrapped: s.wrapped.clone(),
        });
        if !same {
            self.cache = VaultCache::default();
        }
        self.persist()
    }

    /// Applique le résultat de `remote_login` / `remote_register` / `remote_unlock`.
    /// Il reste ensuite à synchroniser si `online`.
    pub fn apply_open(&mut self, o: Opened) -> Result<(), Error> {
        self.lock();
        let online = o.session.is_some();
        if let Some(s) = &o.session {
            self.new_profile(&o.server, s)?;
        }
        self.api = Api::new(&o.server);
        self.api.token = o.session.map(|s| s.token);
        self.key = Some(o.key);
        self.auth = Some(o.auth);
        self.online = online;
        self.decrypt_all();
        Ok(())
    }

    /// Données de session persistante (clé brute + auth) ; None si verrouillé.
    pub fn session_file(&self, expires: Option<u64>) -> Option<crate::session::SessionFile> {
        let (p, key, auth) = (self.profile.as_ref()?, self.key.as_ref()?, self.auth.as_ref()?);
        Some(crate::session::SessionFile {
            server: p.server.clone(),
            user: p.user.clone(),
            key: crypto::b64(key.as_ref()),
            auth: auth.to_string(),
            expires,
        })
    }

    /// Reprise sans mot de passe depuis une session persistante (cf. `Vault.resume` de core.js) :
    /// hors ligne et sans token ; il reste à se reconnecter avec `auth` (`remote_reconnect`).
    pub fn resume(&mut self, s: &crate::session::SessionFile) -> Result<(), Error> {
        let p = self.profile.as_ref().ok_or_else(|| Error::Other("Aucun compte configuré".into()))?;
        if p.server != s.server || p.user != s.user {
            return Err(Error::Other("Session d'un autre compte".into()));
        }
        let raw = Zeroizing::new(crypto::unb64(&s.key)?);
        if raw.len() != 32 {
            return Err(Error::Other("Session invalide".into()));
        }
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&raw);
        self.lock();
        self.api = Api::new(&s.server);
        self.key = Some(key);
        self.auth = Some(Zeroizing::new(s.auth.clone()));
        self.online = false;
        self.decrypt_all();
        // Mauvaise clé : aucune entrée ne se déchiffre.
        if !self.cache.items.is_empty() && self.items.is_empty() {
            self.lock();
            return Err(Error::Other("Session invalide".into()));
        }
        Ok(())
    }

    /// Applique une reconnexion réussie (déverrouillé hors ligne → en ligne).
    pub fn apply_reconnect(&mut self, s: Session) -> Result<(), Error> {
        let server = self.api.server.clone();
        self.new_profile(&server, &s)?;
        self.api.token = Some(s.token);
        self.online = true;
        Ok(())
    }

    pub fn lock(&mut self) {
        self.key = None;
        self.auth = None;
        self.items.clear(); // Drop efface les données
        self.api.token = None;
        self.online = false;
        self.undecryptable = 0;
    }

    fn decrypt_one(&mut self, id: &str, rev: u64, enc: &str) {
        let Some(key) = &self.key else { return };
        match crypto::decrypt_item(key, id, enc) {
            Ok(data) => {
                let fz = SearchFields::new(&data);
                let icon_key = crate::icon::icon_key(&data);
                let kind = crate::icon::entry_kind(&data);
                self.items.insert(id.to_string(), Item { id: id.to_string(), rev, data, fz, icon_key, kind });
            }
            Err(_) => {
                self.undecryptable += 1;
                eprintln!("BioPass : entrée indéchiffrable {id}");
            }
        }
    }

    fn decrypt_all(&mut self) {
        self.items.clear();
        self.undecryptable = 0;
        let all: Vec<(String, CacheItem)> = self.cache.items.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (id, it) in all {
            self.decrypt_one(&id, it.rev, &it.enc);
        }
    }

    /// Applique une réponse de `sync`. Retourne true si quelque chose a changé.
    /// `Offline` → passe hors ligne sans erreur (comme core.js) ; les autres erreurs remontent.
    pub fn apply_sync(&mut self, r: Result<SyncResponse, Error>) -> Result<bool, Error> {
        let r = match r {
            Ok(r) => r,
            Err(Error::Offline) => {
                self.online = false;
                return Ok(false);
            }
            Err(e) => return Err(e),
        };
        self.online = true;
        if !r.full && r.rev == self.cache.rev {
            return Ok(false);
        }
        if r.full {
            self.cache.items.clear();
            self.items.clear();
        }
        for it in &r.items {
            match (&it.enc, it.del) {
                (Some(enc), false) => {
                    self.cache.items.insert(it.id.clone(), CacheItem { rev: it.rev, enc: enc.clone() });
                }
                _ => {
                    self.cache.items.remove(&it.id);
                    self.items.remove(&it.id);
                }
            }
        }
        self.cache.rev = r.rev;
        for it in r.items.iter().filter(|it| !it.del) {
            if let Some(enc) = &it.enc {
                self.decrypt_one(&it.id, it.rev, enc);
            }
        }
        self.persist()?;
        Ok(true)
    }

    /// Chiffre les modifications → (corps de `save`, ids). Erreur si hors ligne ou verrouillé.
    pub fn prepare_save(&self, changes: &[Change]) -> Result<(Vec<Value>, Vec<String>), Error> {
        if self.api.token.is_none() {
            return Err(Error::Other("Hors ligne : modification impossible".into()));
        }
        let key = self.key.as_ref().ok_or_else(|| Error::Other("Coffre verrouillé".into()))?;
        let now = now_ms();
        let prev_of = |id: &str| self.cache.items.get(id).map(|c| c.rev).unwrap_or(0);
        let mut out = Vec::new();
        let mut ids = Vec::new();
        for c in changes {
            match c {
                Change::Delete(id) => {
                    out.push(json!({ "id": id, "prev": prev_of(id), "del": true }));
                    ids.push(id.clone());
                }
                Change::Upsert { id, data } => {
                    let mut obj: Map<String, Value> =
                        data.iter().filter(|(k, _)| !k.starts_with('_')).map(|(k, v)| (k.clone(), v.clone())).collect();
                    if obj.get("created").is_none_or(Value::is_null) {
                        obj.insert("created".into(), json!(now));
                    }
                    obj.insert("updated".into(), json!(now));
                    let (id, prev) = match id {
                        Some(id) => (id.clone(), prev_of(id)),
                        None => (crypto::new_id(), 0),
                    };
                    let enc = crypto::encrypt_item(key, &id, &obj);
                    crypto::wipe_map(&mut obj);
                    out.push(json!({ "id": id, "prev": prev, "enc": enc }));
                    ids.push(id);
                }
            }
        }
        Ok((out, ids))
    }

    // -------------------------------------------------------------- versions bloquantes

    pub fn login(&mut self, server: &str, user: &str, password: &str) -> Result<(), Error> {
        let o = remote_login(server, user, password)?;
        self.apply_open(o)?;
        self.sync().map(|_| ())
    }

    pub fn register(&mut self, server: &str, user: &str, password: &str, code: &str) -> Result<(), Error> {
        let o = remote_register(server, user, password, code)?;
        self.apply_open(o)?;
        self.sync().map(|_| ())
    }

    pub fn unlock(&mut self, password: &str) -> Result<(), Error> {
        let p = self.profile.clone().ok_or_else(|| Error::Other("Aucun compte configuré".into()))?;
        let o = remote_unlock(&p, password)?;
        let online = o.session.is_some();
        self.apply_open(o)?;
        if online {
            self.sync()?;
        }
        Ok(())
    }

    pub fn sync(&mut self) -> Result<bool, Error> {
        if self.api.token.is_none() {
            return Ok(false);
        }
        let r = self.api.sync(self.cache.rev);
        self.apply_sync(r)
    }

    /// Enregistre puis resynchronise (même en cas d'échec, comme core.js).
    pub fn save(&mut self, changes: &[Change]) -> Result<Vec<String>, Error> {
        let (body, ids) = self.prepare_save(changes)?;
        let res = self.api.save(&body);
        let synced = self.sync();
        res?;
        synced?;
        Ok(ids)
    }

    /// Changement du mot de passe maître (la vaultKey ne change pas).
    pub fn change_password(&mut self, old: &str, new: &str) -> Result<(), Error> {
        let p = self.profile.clone().ok_or_else(|| Error::Other("Aucun compte configuré".into()))?;
        let o = crypto::derive_keys(old, &p.salt, p.iter)?;
        let raw = crypto::unwrap_vault_key(&o.wrap_key, &p.wrapped)?;
        let k = crypto::make_account_keys(new, Some(raw), crypto::DEFAULT_ITER)?;
        let token = self.api.password(&o.auth, &k.salt, k.iter, &k.auth, &k.wrapped)?;
        self.api.token = Some(token);
        self.auth = Some(k.auth);
        self.profile = Some(Profile { salt: k.salt, iter: k.iter, wrapped: k.wrapped, ..p });
        self.persist()
    }
}
