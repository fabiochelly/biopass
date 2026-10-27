// BioPass — cœur commun (web + extension). Voir PROTOCOL.md.
// Fichier copié dans extension/lib/core.js par tools/sync-core.sh : modifier ici.

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export const DEFAULT_ITER = 600000;

// ------------------------------------------------------------------ encodages

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const newId = () => Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------------ crypto

async function hkdf(ikm, info) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: te.encode(info) }, k, 256);
  return new Uint8Array(bits);
}

// Mot de passe maître → { auth (b64, envoyé au serveur), wrapKey (CryptoKey) }
export async function deriveKeys(password, saltB64, iter) {
  const pw = await subtle.importKey('raw', te.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const master = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iter }, pw, 256));
  const auth = b64(await hkdf(master, 'biopass/auth'));
  const wrapKey = await subtle.importKey('raw', await hkdf(master, 'biopass/wrap'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  master.fill(0);
  return { auth, wrapKey };
}

async function seal(key, plain, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

async function open(key, b64data, aad) {
  const raw = unb64(b64data);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: te.encode(aad) }, key, raw.subarray(12)));
}

export const importVaultKey = (raw, extractable = false) =>
  subtle.importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt']);

export const wrapVaultKey = (wrapKey, raw) => seal(wrapKey, raw, 'biopass/vaultkey');

export async function unwrapVaultKey(wrapKey, wrapped) {
  try {
    return await open(wrapKey, wrapped, 'biopass/vaultkey');
  } catch {
    throw new Error('Mot de passe incorrect');
  }
}

// Nouveau compte (ou changement de mot de passe si `raw` est fourni).
export async function makeAccountKeys(password, raw = randomBytes(32), iter = DEFAULT_ITER) {
  const salt = b64(randomBytes(16));
  const { auth, wrapKey } = await deriveKeys(password, salt, iter);
  return { salt, iter, auth, wrapped: await wrapVaultKey(wrapKey, raw), raw };
}

export const encryptItem = (vaultKey, id, obj) => seal(vaultKey, te.encode(JSON.stringify(obj)), 'biopass/item/' + id);
export const decryptItem = async (vaultKey, id, enc) => JSON.parse(td.decode(await open(vaultKey, enc, 'biopass/item/' + id)));

// ------------------------------------------------------------------ API

export class ApiError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status; // 0 = serveur injoignable
    this.data = data;
  }
}

// Adresse du serveur telle que saisie (ex. « https://example.com/biopass/?k=GUID »)
// → { base: 'https://example.com/biopass', key: 'GUID' }. '.' = même origine (app web).
export function parseServer(input) {
  let s = (input || '').trim();
  if (s === '' || s === '.') return { base: '.', key: '' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  const path = u.pathname.replace(/\/(index\.html|index\.php|api\.php)$/, '').replace(/\/+$/, '');
  return { base: u.origin + path, key: u.searchParams.get('k') || '' };
}

// Forme normalisée à stocker, et URL de l'app web correspondante.
export function normServer(input) {
  const { base, key } = parseServer(input);
  return base + (key ? '/?k=' + encodeURIComponent(key) : '');
}
export const webUrl = (server) => {
  const { base, key } = parseServer(server);
  return base + '/' + (key ? '?k=' + encodeURIComponent(key) : '');
};

export class Api {
  constructor(server = '.') {
    const { base, key } = parseServer(server);
    this.base = base;
    this.key = key; // clé d'accès optionnelle (en-tête X-BP-Key)
    this.token = null;
  }

  async _fetch(action, body, query, timeout = 0) {
    // same-origin : l'app web s'appuie sur le cookie posé par le serveur pour la clé d'accès
    const opt = { method: body ? 'POST' : 'GET', headers: {}, cache: 'no-store', credentials: 'same-origin' };
    if (timeout) opt.signal = AbortSignal.timeout(timeout);
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    if (this.key) opt.headers['X-BP-Key'] = this.key;
    if (this.token) opt.headers['X-BP-Token'] = this.token;
    try {
      return await fetch(`${this.base}/api.php?a=${action}${query}`, opt);
    } catch (e) {
      if (e.name === 'TimeoutError') throw new ApiError(504, 'Délai dépassé');
      throw new ApiError(0, 'Serveur injoignable');
    }
  }

  // Réponse binaire (icônes) : Blob, ou null si introuvable (404).
  async blob(action, query = '', timeout = 0) {
    const res = await this._fetch(action, null, query, timeout);
    if (res.status === 404) return null;
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch {}
      throw new ApiError(res.status, data.error || `Erreur serveur (${res.status})`, data);
    }
    return res.blob();
  }

  async call(action, body, query = '') {
    const res = await this._fetch(action, body, query);
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw new ApiError(res.status, data.error || `Erreur serveur (${res.status})`, data);
    return data;
  }

  prelogin(user) { return this.call('prelogin', { user }); }
  login(user, auth) { return this.call('login', { user, auth }); }
  register(body) { return this.call('register', body); }
  sync(since) { return this.call('sync', null, `&since=${since}`); }
  save(changes) { return this.call('save', { changes }); }
  password(body) { return this.call('password', body); }
  revoke() { return this.call('revoke', {}); }
}

// ------------------------------------------------------------------ coffre

// storage : { get(key) → Promise<any>, set(key, value) → Promise, remove(key) → Promise }
// Clés utilisées : 'profile' = {server, user, salt, iter, wrapped}, 'vault' = {rev, items:{id:{rev, enc}}}
export class Vault {
  constructor(storage, { keepRaw = false } = {}) {
    this.storage = storage;
    this.keepRaw = keepRaw;
    this.reset();
  }

  reset() {
    this.profile = null;
    this.cache = { rev: 0, items: {} };
    this.key = null;
    this.rawKey = null; // b64, uniquement si keepRaw (extension, session d'onglet du site)
    this.auth = null; // clé d'authentification dérivée, si keepRaw : reconnexion sans mot de passe
    this.items = new Map(); // id → entrée déchiffrée (avec ._id, ._rev)
    this.online = false;
    this.api = new Api('.');
  }

  get unlocked() { return !!this.key; }

  async load() {
    this.profile = (await this.storage.get('profile')) || null;
    this.cache = (await this.storage.get('vault')) || { rev: 0, items: {} };
    if (this.profile) this.api = new Api(this.profile.server);
    return this.profile;
  }

  async _open(raw, token, online) {
    this.key = await importVaultKey(raw, false);
    if (this.keepRaw) this.rawKey = b64(raw);
    raw.fill(0);
    this.api.token = token;
    this.online = online;
    await this._decryptAll();
    if (online) await this.sync();
  }

  // Première connexion sur cet appareil (ou changement d'utilisateur).
  async login(server, user, password) {
    user = user.trim().toLowerCase();
    server = normServer(server);
    const api = new Api(server);
    const pre = await api.prelogin(user);
    const { auth, wrapKey } = await deriveKeys(password, pre.salt, pre.iter);
    const r = await api.login(user, auth);
    const raw = await unwrapVaultKey(wrapKey, r.wrapped);
    await this._newProfile(server, r);
    this.api = api;
    if (this.keepRaw) this.auth = auth;
    await this._open(raw, r.token, true);
  }

  async register(server, user, password, code) {
    user = user.trim().toLowerCase();
    server = normServer(server);
    const api = new Api(server);
    const k = await makeAccountKeys(password);
    const r = await api.register({ user, code, salt: k.salt, iter: k.iter, auth: k.auth, wrapped: k.wrapped });
    await this._newProfile(server, r);
    this.api = api;
    if (this.keepRaw) this.auth = k.auth;
    await this._open(k.raw, r.token, true);
  }

  async _newProfile(server, r) {
    const same = this.profile && this.profile.server === server && this.profile.user === r.user;
    this.profile = { server, user: r.user, salt: r.salt, iter: r.iter, wrapped: r.wrapped };
    await this.storage.set('profile', this.profile);
    if (!same) {
      this.cache = { rev: 0, items: {} };
      await this.storage.set('vault', this.cache);
    }
  }

  // Déverrouillage : en ligne si possible (rafraîchit le profil), sinon depuis le cache.
  async unlock(password) {
    const p = this.profile;
    if (!p) throw new Error('Aucun compte configuré');
    try {
      const pre = await this.api.prelogin(p.user);
      const { auth, wrapKey } = await deriveKeys(password, pre.salt, pre.iter);
      const r = await this.api.login(p.user, auth);
      const raw = await unwrapVaultKey(wrapKey, r.wrapped);
      await this._newProfile(p.server, r);
      if (this.keepRaw) this.auth = auth;
      return await this._open(raw, r.token, true);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 0) throw e;
    }
    const { auth, wrapKey } = await deriveKeys(password, p.salt, p.iter);
    const raw = await unwrapVaultKey(wrapKey, p.wrapped);
    if (this.keepRaw) this.auth = auth; // permettra de se reconnecter au retour du réseau
    await this._open(raw, null, false);
  }

  // Reprise sans mot de passe (extension après redémarrage du service worker, F5 du site).
  // Le cache n'est relu que s'il ne l'a pas déjà été (plusieurs Mo avec les icônes).
  async resume(rawKeyB64, token, auth = null) {
    if (!this.profile) await this.load();
    this.key = await importVaultKey(unb64(rawKeyB64), false);
    this.rawKey = rawKeyB64;
    this.auth = auth;
    this.api.token = token;
    this.online = !!token;
    await this._decryptAll();
  }

  lock() {
    this.key = null;
    this.rawKey = null;
    this.auth = null;
    this.items = new Map();
    this.api.token = null;
  }

  async forget() {
    await this.storage.remove('profile');
    await this.storage.remove('vault');
    this.reset();
  }

  async _decrypt(id, it) {
    try {
      const obj = await decryptItem(this.key, id, it.enc);
      obj._id = id;
      obj._rev = it.rev;
      this.items.set(id, obj);
    } catch {
      console.warn('BioPass: entrée indéchiffrable', id);
    }
  }

  async _decryptAll() {
    this.items = new Map();
    await Promise.all(Object.entries(this.cache.items).map(([id, it]) => this._decrypt(id, it)));
  }

  // Nouvelle session serveur sans mot de passe (token expiré, retour du réseau). Échoue (401)
  // si le mot de passe maître a été changé ailleurs.
  async relogin() {
    if (!this.auth || !this.profile) return false;
    const r = await this.api.login(this.profile.user, this.auth);
    this.api.token = r.token;
    this.online = true;
    return true;
  }

  // Récupère les changements du serveur. Retourne true si quelque chose a changé.
  async sync() {
    if (!this.api.token) return false;
    let r;
    try {
      r = await this.api.sync(this.cache.rev);
    } catch (e) {
      if (e.status === 0) {
        this.online = false;
        return false;
      }
      throw e;
    }
    this.online = true;
    if (!r.full && r.rev === this.cache.rev) return false;
    if (r.full) {
      this.cache.items = {};
      this.items = new Map();
    }
    for (const it of r.items) {
      if (it.del) {
        delete this.cache.items[it.id];
        this.items.delete(it.id);
      } else {
        this.cache.items[it.id] = { rev: it.rev, enc: it.enc };
      }
    }
    this.cache.rev = r.rev;
    await Promise.all(r.items.filter((it) => !it.del).map((it) => this._decrypt(it.id, it)));
    await this.storage.set('vault', this.cache);
    return true;
  }

  // changes : [{ item }] (création/modif) ou [{ id, del: true }]
  // touch: false → ne pas changer la date de modification (ajout d'une icône, par exemple)
  async save(changes, { touch = true } = {}) {
    if (!this.api.token) throw new ApiError(0, 'Hors ligne : modification impossible');
    const now = Date.now();
    const out = await Promise.all(changes.map(async (c) => {
      if (c.del) return { id: c.id, prev: this.cache.items[c.id]?.rev ?? 0, del: true };
      const obj = Object.fromEntries(Object.entries(c.item).filter(([k]) => !k.startsWith('_')));
      const _id = c.item._id;
      const id = _id || newId();
      obj.created ??= now;
      if (touch || !obj.updated) obj.updated = now;
      return { id, prev: _id ? (this.cache.items[_id]?.rev ?? 0) : 0, enc: await encryptItem(this.key, id, obj) };
    }));
    try {
      await this.api.save(out);
    } finally {
      await this.sync();
    }
    return out.map((c) => c.id);
  }

  async changePassword(oldPassword, newPassword) {
    const p = this.profile;
    const old = await deriveKeys(oldPassword, p.salt, p.iter);
    const raw = await unwrapVaultKey(old.wrapKey, p.wrapped);
    const k = await makeAccountKeys(newPassword, raw);
    const r = await this.api.password({ auth: old.auth, salt: k.salt, iter: k.iter, auth_new: k.auth, wrapped: k.wrapped });
    raw.fill(0);
    this.api.token = r.token;
    if (this.keepRaw) this.auth = k.auth;
    this.profile = { ...p, salt: k.salt, iter: k.iter, wrapped: k.wrapped };
    await this.storage.set('profile', this.profile);
  }

  list() { return [...this.items.values()]; }

  // Crée un partage. payload : { from, message, items } ; meta : { title } (visible seulement par l'expéditeur).
  // Retourne { id, k, pin }.
  async createSend(payload, { title, expiresIn, maxViews, pin = '' }) {
    const id = b64url(randomBytes(16));
    const k = randomBytes(16);
    const { access, key } = await sendKeys(k, pin);
    const enc = await seal(key, te.encode(JSON.stringify(payload)), 'biopass/send/' + id);
    // l'expéditeur retrouve le titre, le lien et le code dans sa liste (chiffrés avec la clé du coffre)
    const label = await seal(this.key, te.encode(JSON.stringify({ title, k: b64url(k), pin })), 'biopass/send-label/' + id);
    await this.api.call('send_create', { id, enc, access, label, expires_in: expiresIn, max_views: maxViews, pin: !!pin });
    return { id, k: b64url(k), pin };
  }

  // Partages envoyés : { sends:[{ id, title, k, pin, created, expires, views, max_views, alive, opened }], smtp }
  async listSends() {
    const r = await this.api.call('send_list', null);
    const sends = await Promise.all(r.sends.map(async (s) => {
      try {
        return { ...s, ...JSON.parse(td.decode(await open(this.key, s.label, 'biopass/send-label/' + s.id))) };
      } catch {
        return { ...s, title: '(illisible)' };
      }
    }));
    return { sends, smtp: r.smtp };
  }

  deleteSend(id) { return this.api.call('send_delete', { id }); }

  // Sauvegardes quotidiennes du serveur : [{date, rev, count}], la plus récente d'abord.
  async listBackups() {
    return (await this.api.call('backups', null)).backups;
  }

  // Contenu déchiffré d'une sauvegarde (même clé de coffre) : Map id → entrée.
  async loadBackup(date) {
    const r = await this.api.call('backup', null, '&date=' + encodeURIComponent(date));
    const out = new Map();
    await Promise.all(r.items.map(async (it) => {
      try {
        const obj = await decryptItem(this.key, it.id, it.enc);
        obj._id = it.id;
        out.set(it.id, obj);
      } catch {}
    }));
    return out;
  }

  // Icônes des sites, en tâche de fond : une requête par site, `concurrency` à la fois, au plus
  // `limit` sites par appel. Les échecs sont notés (iconTry) et retentés au bout de 30 jours.
  // Ne modifie pas la date de modification des entrées. Retourne le nombre d'entrées mises à jour.
  // retry : retenter aussi les échecs récents (bouton « Récupérer les icônes »).
  async fetchIcons({ limit = 20, concurrency = 2, ids = null, onProgress = null, retry = false } = {}) {
    if (!this.api.token || !this.key) return 0;
    const now = Date.now();
    const byHost = new Map();
    for (const it of this.items.values()) {
      const fresh = it.icon && (it.iconV || 1) >= ICON_VERSION;
      if (ids ? !ids.includes(it._id) : (fresh || (!it.icon && !retry && it.iconTry && now - it.iconTry < ICON_RETRY))) continue;
      const host = iconHost(it);
      if (host && !(now - (iconErrors.get(host) || 0) < ICON_ERROR_RETRY)) byHost.set(host, [...(byHost.get(host) || []), it]);
    }
    const hosts = [...byHost.keys()].slice(0, limit);
    const changes = [];
    let done = 0;
    let offline = false;
    const worker = async () => {
      while (hosts.length && !offline) {
        const host = hosts.shift();
        let icon = null;
        try {
          const blob = await this.api.blob('favicon', '&url=' + encodeURIComponent('https://' + host), 45000);
          icon = blob ? await iconFromBlob(blob) : null;
        } catch (e) {
          if (e.status === 0) offline = true;
          if (e.status === 0 || e.status === 401 || e.status === 501) return;
          // erreur passagère (délai dépassé, 502…) : rien n'est enregistré (surtout pas « à jour » avec
          // l'ancienne icône) ; ce site est réessayé une heure plus tard
          iconErrors.set(host, now);
          icon = undefined;
        }
        if (icon !== undefined) { // undefined : format illisible dans ce contexte, un autre client réessaiera
          for (const it of byHost.get(host)) {
            // échec d'une mise à niveau : on garde l'ancienne icône
            if (!icon && it.icon) changes.push({ item: { ...it, iconV: ICON_VERSION } });
            else changes.push({ item: icon ? { ...it, icon: icon.icon, iconTone: icon.tone || undefined, iconV: ICON_VERSION, iconTry: undefined } : { ...it, iconTry: now } });
          }
        }
        onProgress?.(++done, done + hosts.length);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    let saved = 0;
    for (let i = 0; i < changes.length; i += 50) {
      try {
        await this.save(changes.slice(i, i + 50), { touch: false });
        saved += Math.min(50, changes.length - i);
      } catch (e) {
        if (e.status !== 409) throw e; // entrée modifiée entre-temps : on réessaiera plus tard
      }
    }
    return saved;
  }
}

// ------------------------------------------------------------------ Send : partages chiffrés de bout en bout
// Lien : <base>/index.php?s=<id>#<k>. La clé k (16 octets) reste dans le fragment, jamais envoyé au serveur.
// Avec un code : secret = PBKDF2(code, sel = k) ; sinon secret = k. Du secret dérivent la preuve d'accès
// (envoyée, hachée côté serveur) et la clé de chiffrement du contenu (jamais envoyée).

export const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

async function sendKeys(k, pin) {
  let secret = k;
  if (pin) {
    const p = await subtle.importKey('raw', te.encode(pin.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    secret = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: k, iterations: 200000 }, p, 256));
  }
  return {
    access: b64(await hkdf(secret, 'biopass/send-access')),
    key: await subtle.importKey('raw', await hkdf(secret, 'biopass/send-key'), 'AES-GCM', false, ['encrypt', 'decrypt']),
  };
}

// Code à 6 chiffres, à transmettre par un autre canal que le lien.
export function sendPin() {
  return String(randInt(1000000)).padStart(6, '0');
}

// Ouvre un partage (page du destinataire) : { payload, expires, viewsLeft }.
export async function openSend(api, id, k, pin) {
  const { access, key } = await sendKeys(unb64url(k), pin);
  const r = await api.call('send_open', { id, access }, '&s=' + id);
  const payload = JSON.parse(td.decode(await open(key, r.enc, 'biopass/send/' + id)));
  return { payload, expires: r.expires, viewsLeft: r.views_left };
}

// ------------------------------------------------------------------ comparaison de deux états du coffre

export const DIFF_FIELDS = [
  ['name', 'Nom'], ['username', 'Identifiant'], ['password', 'Mot de passe', true], ['uris', 'Sites'],
  ['totp', 'Clé 2FA', true], ['folder', 'Dossier'], ['notes', 'Notes'], ['fav', 'Favori'], ['fields', 'Champs personnalisés'],
];

function diffValue(it, key) {
  const v = it?.[key];
  if (key === 'uris') return (v || []).join('\n');
  if (key === 'fields') return (v || []).map((f) => `${f.name} : ${f.value}`).join('\n');
  if (key === 'fav') return v ? 'oui' : '';
  return v == null ? '' : String(v);
}

// before/after : Map id → entrée. Retourne { added, removed, changed:[{ before, after, fields:[{key,label,secret,before,after}] }] }
// (dates, icône et historique ignorés : seul le contenu compte).
export function diffVaults(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, it] of after) if (!before.has(id)) added.push(it);
  for (const [id, old] of before) {
    const cur = after.get(id);
    if (!cur) {
      removed.push(old);
      continue;
    }
    const fields = [];
    for (const [key, label, secret] of DIFF_FIELDS) {
      const a = diffValue(old, key);
      const b = diffValue(cur, key);
      if (a !== b) fields.push({ key, label, secret: !!secret, before: a, after: b });
    }
    if (fields.length) changed.push({ before: old, after: cur, fields });
  }
  const byName = (a, b) => (fold(a.name) < fold(b.name) ? -1 : 1);
  added.sort(byName);
  removed.sort(byName);
  changed.sort((a, b) => byName(a.after, b.after));
  return { added, removed, changed };
}

// ------------------------------------------------------------------ icônes des sites

export const ICON_SIZE = 128;
export const ICON_VERSION = 6; // 2 : 64 px + Scale2x ; 3 : Scale2x réservé aux aplats ; 4 : 128 px ; 5 : reprise des icônes marquées à jour après une erreur ; 6 : icônes intégrées (Google) (les icônes plus anciennes sont refaites)
const ICON_RETRY = 30 * 86400000;
const ICON_ERROR_RETRY = 3600000;
const iconErrors = new Map(); // site → date de la dernière erreur (pour cette session)

// Hôte dont on cherche l'icône : première adresse web (ou ssh) de l'entrée, sans « www. ».
export function iconHost(it) {
  for (const u of it.uris || []) {
    if (/^(?![a-z][a-z0-9+.-]*:)|^(https?|ssh):/i.test(u)) {
      const h = hostOf(u).replace(/^www\./, '');
      // pas d'adresse IP ni de nom local : aucune icône accessible depuis le serveur
      if (h && h.includes('.') && !/^[\d.]+$/.test(h) && !/\.(local|lan|home|internal|localdomain)$/.test(h)) return h;
    }
  }
  return '';
}

// Catégorie d'une entrée sans icône de site, pour lui donner une icône dédiée.
// network : IP / réseau local ; terminal : SSH ; app : appli Android ; wifi ; card ; key : clé, jeton ;
// note : note ou entrée sans site. null : initiale.
export function entryKind(it) {
  const uris = it.uris || [];
  const hosts = uris.map(hostOf);
  const text = fold(`${it.name || ''} ${it.folder || ''}`);
  // IPv4, IPv6 (entre crochets dans une URL), localhost ou nom de réseau local
  if (hosts.some((h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h === 'localhost' || /\.(local|lan|home|internal|localdomain)$/.test(h))) return 'network';
  if (uris.some((u) => /^ssh:/i.test(u)) || /\bssh\b|\bsftp\b|serveur|\bvps\b/.test(text)) return 'terminal';
  if (/wi-?fi|\bssid\b|\bwlan\b|\bbox\b/.test(text)) return 'wifi';
  const fieldNames = fold((it.fields || []).map((f) => f.name).join(' '));
  if (/\b(carte|visa|mastercard|amex|cb)\b/.test(text) || (/numero/.test(fieldNames) && /(code|cvv|cvc|exp)/.test(fieldNames))) return 'card';
  if (/\b(api|token|jeton|cle|key|licen[cs]e|ssh-key)\b/.test(text)) return 'key';
  if (uris.length && uris.every((u) => /^androidapp:/i.test(u))) return 'app';
  if (it.type === 'note' || !uris.length) return 'note';
  return null;
}

// Scale2x (EPX) : double la taille d'une petite image en préservant les contours (pas de flou, pas de gros pixels).
function scale2x(src, w, h) {
  const W = w * 2;
  const dst = new Uint32Array(W * h * 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const P = src[y * w + x];
      const A = y > 0 ? src[(y - 1) * w + x] : P;
      const B = x < w - 1 ? src[y * w + x + 1] : P;
      const C = x > 0 ? src[y * w + x - 1] : P;
      const D = y < h - 1 ? src[(y + 1) * w + x] : P;
      const o = 2 * y * W + 2 * x;
      dst[o] = C === A && C !== D && A !== B ? A : P;
      dst[o + 1] = A === B && A !== C && B !== D ? B : P;
      dst[o + W] = D === C && D !== B && C !== A ? C : P;
      dst[o + W + 1] = B === D && B !== A && D !== C ? D : P;
    }
  }
  return dst;
}

const newCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

// Image téléchargée → { icon: PNG carré ICON_SIZE en data: URL, tone: 'dark'|'light'|'' } ; null si vide ;
// undefined si le format n'est pas lisible ici (SVG dans un service worker, par exemple).
// tone : icône très sombre (ou très claire) sur fond transparent → contour discret selon le thème.
export async function iconFromBlob(blob) {
  let img;
  try {
    img = await createImageBitmap(blob);
  } catch {
    if (typeof Image === 'undefined') return undefined;
    const url = URL.createObjectURL(blob);
    try {
      img = new Image();
      img.src = url;
      await img.decode();
    } catch {
      return undefined;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const vector = blob.type === 'image/svg+xml';
  let src = img;
  let w = img.width || ICON_SIZE;
  let h = img.height || ICON_SIZE;
  const S = ICON_SIZE;
  if (!vector && Math.max(w, h) < S / 1.4 && w * h <= 4096) {
    // petite source à aplats (pixel art, peu de couleurs) : agrandissements Scale2x successifs avant le
    // lissage final. Un logo en dégradés ou anti-crénelé (Meta…) n'a pas de voisins identiques : Scale2x
    // y doublerait simplement les pixels, le lissage seul donne alors un meilleur résultat.
    const c = newCanvas(w, h);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    let px = new Uint32Array(g.getImageData(0, 0, w, h).data.buffer);
    const flat = new Set(px).size <= 48;
    while (flat && Math.max(w, h) < S / 1.4) {
      px = scale2x(px, w, h);
      w *= 2;
      h *= 2;
    }
    if (flat) {
      src = newCanvas(w, h);
      src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
    }
  }
  const canvas = newCanvas(S, S);
  const g = canvas.getContext('2d');
  const k = Math.min(S / w, S / h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, (S - w * k) / 2, (S - h * k) / 2, w * k, h * k);
  const px = g.getImageData(0, 0, S, S).data;
  let visible = 0;
  let lum = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 128) {
      visible++;
      lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    }
  }
  if (visible < 40) return null; // image vide ou quasi transparente
  lum /= visible * 255;
  const transparent = px[3] < 30 && px[(S - 1) * 4 + 3] < 30 && px[(S * S - 1) * 4 + 3] < 30; // coins transparents
  const tone = transparent && lum < 0.22 ? 'dark' : transparent && lum > 0.85 ? 'light' : '';
  const png = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return { icon: 'data:image/png;base64,' + b64(new Uint8Array(await png.arrayBuffer())), tone };
}

// ------------------------------------------------------------------ recherche approximative
// Spécification commune (web, extension, Android, bureau) : voir PROTOCOL.md § 5 et
// tools/search-vectors.json. Toute modification doit être reportée dans les autres clients.

// minuscules, sans accents, « œ/æ » développés
export function fold(str) {
  return (str || '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const SEP = /[^a-z0-9]+/;
const WEIGHTS = { name: 1, both: 0.9, rev: 0.9, host: 0.8, username: 0.7, folder: 0.5 };

const isSep = (c) => !((c >= 97 && c <= 122) || (c >= 48 && c <= 57)); // code de caractère hors [a-z0-9]
const words = (s) => s.split(SEP).filter(Boolean);

function fuzzyFields(it) {
  const name = fold(it.name);
  const username = fold(it.username);
  const f = {
    name,
    both: username ? name + ' ' + username : '', // « applis » → titre « Apple » + identifiant « lisa »
    rev: username ? username + ' ' + name : '', // « lisapple » → identifiant « lisa » + titre « Apple »
    host: (it.uris || []).map((u) => fold(hostOf(u)).replace(/^www\./, '')).join(' '),
    username,
    folder: fold(it.folder),
  };
  // mots pré-découpés (fautes de frappe, découpe titre/identifiant) : calculés une fois par entrée
  f.words = Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, words(f[k])]));
  return f;
}

// Distance de Damerau-Levenshtein (transpositions adjacentes), bornée à max+1, entre a et les
// bLen premiers caractères de b. Trois lignes réutilisées : aucune allocation par comparaison.
let dlRows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];
function editDistance(a, b, max, bLen = b.length) {
  if (Math.abs(a.length - bLen) > max) return max + 1;
  if (bLen + 1 > dlRows[0].length) dlRows = [0, 1, 2].map(() => new Int32Array(bLen + 1));
  let [prev2, prev, cur] = dlRows;
  for (let j = 0; j <= bLen; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const bj = b.charCodeAt(j - 1);
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[bLen];
}

// Score d'un terme dans un champ (0 = absent) :
// 100 début du champ, 90 début de mot, 70 sous-chaîne, 30-60 lettres dans l'ordre (≥ 3 lettres),
// 40 faute de frappe (≥ 4 lettres : 1 erreur, ≥ 8 : 2) sur un mot ou le début d'un mot.
export function termScore(t, field, fieldWords = null) {
  if (!field || !t) return 0;
  const i = field.indexOf(t);
  if (i === 0) return 100;
  if (i > 0) return isSep(field.charCodeAt(i - 1)) ? 90 : 70;
  if (t.length < 3) return 0;
  // lettres dans l'ordre, la première en début de mot, sur une étendue d'au plus 3× la longueur
  let best = 0;
  for (let start = 0; start < field.length; start++) {
    if (field[start] !== t[0] || (start > 0 && !isSep(field.charCodeAt(start - 1)))) continue;
    let k = 1;
    let j = start + 1;
    for (; j < field.length && k < t.length; j++) if (field[j] === t[k]) k++;
    if (k === t.length) {
      const span = j - start;
      if (span <= t.length * 3) best = Math.max(best, Math.round(30 + 30 * t.length / span));
    }
  }
  if (best) return best;
  if (t.length < 4) return 0;
  const max = t.length >= 8 ? 2 : 1;
  for (const w of fieldWords || field.split(SEP)) {
    if (w.length < 2 || Math.abs(w.length - t.length) > max && w.length < t.length) continue;
    if (editDistance(t, w, max) <= max || (w.length > t.length && editDistance(t, w, max, t.length) <= max)) return 40;
  }
  return 0;
}

// « lisapp » → début d'un mot de `a` (« lis » de lisamartin@icloud.example) + début d'un mot de `b`
// (« app » de Apple) ; chaque morceau fait au moins 2 lettres, et le premier peut aussi être un extrait
// quelconque de `a` s'il fait au moins 3 lettres (« martinapp »). 80 si trouvé, sinon 0.
export function splitScore(t, a, b, wa = words(a), wb = words(b)) {
  if (t.length < 4 || !a || !b) return 0;
  for (let k = 2; k <= t.length - 2; k++) {
    const p1 = t.slice(0, k);
    const p2 = t.slice(k);
    if ((wa.some((w) => w.startsWith(p1)) || (k >= 3 && a.includes(p1))) && wb.some((w) => w.startsWith(p2))) return 80;
  }
  return 0;
}

export function searchScore(it, terms) {
  const f = it._fz ??= fuzzyFields(it);
  let total = 0;
  for (const t of terms) {
    let best = 0;
    for (const k in WEIGHTS) best = Math.max(best, termScore(t, f[k], f.words[k]) * WEIGHTS[k]);
    if (best < 72) { // 80 × 0,9 : la découpe ne peut pas faire mieux qu'une correspondance déjà trouvée
      const w = f.words;
      best = Math.max(best, Math.max(splitScore(t, f.username, f.name, w.username, w.name), splitScore(t, f.name, f.username, w.name, w.username)) * 0.9);
    }
    if (!best) return 0;
    total += best;
  }
  return total + (it.fav ? 5 : 0);
}

// Prépare la recherche approximative d'une entrée à l'avance (temps libre après l'affichage) : la
// première frappe n'a alors plus à le faire pour tout le coffre.
export function prepareSearch(it) {
  it._fz ??= fuzzyFields(it);
}

// Toutes les entrées si la requête est vide (favoris d'abord, puis ordre alphabétique) ;
// sinon celles qui contiennent tous les termes, par score décroissant puis par nom.
export function search(items, query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const scored = [];
  for (const it of items) {
    const score = terms.length ? searchScore(it, terms) : (it.fav ? 1 : 0);
    if (terms.length && !score) continue;
    // clé de tri : nom normalisé, gardé en cache ; sans requête, inutile de préparer toute la recherche
    // approximative (adresses analysées…) de chaque entrée : l'ouverture d'une liste reste immédiate
    scored.push([score, it._fz?.name ?? (it._fn ??= fold(it.name)), it]);
  }
  scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return scored.map((x) => x[2]);
}

// ------------------------------------------------------------------ domaines

const MULTI = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp',
  'com.br', 'com.mx', 'co.za', 'com.tr', 'co.in', 'com.cn', 'com.hk', 'com.sg', 'co.kr', 'com.ar', 'gouv.fr', 'asso.fr', 'co.il']);

export function hostOf(uri) {
  if (!uri) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : 'https://' + uri).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function baseDomain(host) {
  host = (host || '').toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return host;
  const p = host.split('.');
  if (p.length <= 2) return host;
  return MULTI.has(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

export function matchesUrl(item, pageUrl) {
  const d = baseDomain(hostOf(pageUrl));
  return !!d && (item.uris || []).some((u) => baseDomain(hostOf(u)) === d);
}

// ------------------------------------------------------------------ TOTP

function base32(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.toUpperCase().replace(/[\s=-]/g, '');
  const out = [];
  let bits = 0, val = 0;
  for (const c of s) {
    const i = alpha.indexOf(c);
    if (i < 0) throw new Error('Secret TOTP invalide');
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function parseTotp(str) {
  str = (str || '').trim();
  const p = { secret: str, digits: 6, period: 30, algo: 'SHA-1' };
  if (str.toLowerCase().startsWith('otpauth://')) {
    const u = new URL(str);
    p.secret = u.searchParams.get('secret') || '';
    p.digits = parseInt(u.searchParams.get('digits')) || 6;
    p.period = parseInt(u.searchParams.get('period')) || 30;
    p.algo = { SHA256: 'SHA-256', SHA512: 'SHA-512' }[(u.searchParams.get('algorithm') || '').toUpperCase()] || 'SHA-1';
  }
  return p;
}

export async function totp(str, now = Date.now()) {
  const p = parseTotp(str);
  const counter = Math.floor(now / 1000 / p.period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await subtle.importKey('raw', base32(p.secret), { name: 'HMAC', hash: p.algo }, false, ['sign']);
  const h = new Uint8Array(await subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return {
    code: String(bin % 10 ** p.digits).padStart(p.digits, '0'),
    remaining: p.period - (Math.floor(now / 1000) % p.period),
    period: p.period,
  };
}

// ------------------------------------------------------------------ générateur

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%&*-_=+?.:;',
};

function randInt(n) {
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= max);
  return buf[0] % n;
}

export function generatePassword({ length = 20, lower = true, upper = true, digits = true, symbols = true } = {}) {
  const sets = Object.entries({ lower, upper, digits, symbols }).filter(([, on]) => on).map(([k]) => SETS[k]);
  if (!sets.length) sets.push(SETS.lower);
  const all = sets.join('');
  for (;;) {
    const pw = Array.from({ length }, () => all[randInt(all.length)]).join('');
    if (length < sets.length || sets.every((s) => [...pw].some((c) => s.includes(c)))) return pw;
  }
}

// ------------------------------------------------------------------ import Bitwarden (JSON non chiffré)

export function parseBitwarden(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Fichier JSON invalide');
  }
  if (data.encrypted) throw new Error('Export chiffré : exportez au format « .json » (non chiffré)');
  if (!Array.isArray(data.items)) throw new Error('Format Bitwarden non reconnu');
  const folders = Object.fromEntries((data.folders || []).map((f) => [f.id, f.name]));
  const collections = Object.fromEntries((data.collections || []).map((c) => [c.id, c.name]));
  const date = (s) => Date.parse(s) || undefined;
  return data.items.map((bw) => {
    const it = {
      type: bw.type === 1 ? 'login' : 'note',
      name: bw.name || '',
      folder: folders[bw.folderId] || collections[bw.collectionIds?.[0]] || '',
      fav: !!bw.favorite,
      notes: bw.notes || '',
      fields: (bw.fields || []).map((f) => ({ name: f.name || '', value: f.value ?? '', hidden: f.type === 1 })),
      created: date(bw.creationDate),
    };
    if (bw.login) {
      it.username = bw.login.username || '';
      it.password = bw.login.password || '';
      it.totp = bw.login.totp || '';
      it.uris = (bw.login.uris || []).map((u) => u.uri).filter(Boolean);
      if (bw.login.fido2Credentials?.length) {
        it.fields.push({ name: 'Passkey', value: 'Passkey Bitwarden non importée (à recréer sur le site)', hidden: false });
      }
    }
    const history = (bw.passwordHistory || []).filter((p) => p.password).map((p) => ({ password: p.password, date: date(p.lastUsedDate) || 0 }));
    if (history.length) it.history = history;
    const extra = (obj, labels) => {
      for (const [k, label, hidden] of labels) {
        if (obj?.[k]) it.fields.push({ name: label, value: String(obj[k]), hidden: !!hidden });
      }
    };
    extra(bw.card, [['cardholderName', 'Titulaire'], ['brand', 'Type'], ['number', 'Numéro', 1], ['expMonth', 'Mois exp.'],
      ['expYear', 'Année exp.'], ['code', 'Code', 1]]);
    extra(bw.identity, [['title', 'Civilité'], ['firstName', 'Prénom'], ['lastName', 'Nom'], ['email', 'E-mail'],
      ['phone', 'Téléphone'], ['address1', 'Adresse'], ['address2', 'Adresse 2'], ['postalCode', 'Code postal'],
      ['city', 'Ville'], ['country', 'Pays'], ['company', 'Société'], ['ssn', 'N° sécu', 1], ['passportNumber', 'Passeport', 1],
      ['licenseNumber', 'Permis', 1], ['username', 'Identifiant']]);
    extra(bw.sshKey, [['publicKey', 'Clé publique'], ['privateKey', 'Clé privée', 1], ['keyFingerprint', 'Empreinte']]);
    return it;
  });
}

// Ajoute l'ancien mot de passe à l'historique lors d'une modification (10 derniers).
export function withHistory(prev, next) {
  if (!prev?.password || prev.password === next.password) return next;
  return { ...next, history: [{ password: prev.password, date: Date.now() }, ...(prev.history || [])].slice(0, 10) };
}
