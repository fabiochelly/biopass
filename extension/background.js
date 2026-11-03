// BioPass — service worker de l'extension.
// La clé du coffre vit en mémoire (chrome.storage.session, jamais écrite sur disque) ;
// le cache chiffré est dans chrome.storage.local. Les mots de passe ne sont transmis
// à une page que si le domaine de la frame qui les demande correspond à l'entrée.
import { Vault, matchesUrl, pageKey, totp, hostOf, baseDomain, newId, generatePassword, withHistory, entryKind, search, createPasskey, signPasskey, rpIdAllowed, importVaultKey, encryptItem, decryptItem, b64, unb64 } from './lib/core.js';

// Repères du démarrage (ms depuis le lancement du service worker), lus par tools/bench-extension.mjs.
const boot = { started: Date.now() - Math.round(performance.now()), imports: Math.round(performance.now()) };
const mark = (k) => { boot[k] = Math.round(performance.now()); };

// Chaque écriture du cache du coffre incrémente vaultGen : l'instantané léger (cf. writeLite) n'est
// utilisé au démarrage que s'il a été fait depuis la dernière écriture.
let vaultGen = 0;
let liteGen = -1;
const storage = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => {
    if (k !== 'vault') return chrome.storage.local.set({ [k]: v });
    scheduleLite();
    return chrome.storage.local.set({ vault: v, vaultGen: ++vaultGen });
  },
  remove: (k) => chrome.storage.local.remove(k === 'vault' ? ['vault', 'lite'] : k),
};

const vault = new Vault(storage, { keepRaw: true });
// lock : minutes d'inactivité avant verrouillage ; 0 = à la fermeture du navigateur ;
// -1 = jamais (clé conservée sur disque, reconnexion automatique au serveur).
const DEFAULT_PREFS = { lock: -1, inline: true, savePrompt: true, window: false };
let prefs = { ...DEFAULT_PREFS };
const nonces = new Map(); // nonce → { tabId, expires } : autorise un remplissage forcé demandé par l'utilisateur
let pending = {}; // tabId → proposition d'enregistrement
let refused = {}; // tabId → { domain, url, tags } : propositions refusées, cf. dismissSave
let lastUser = {}; // tabId → { user, domain, t } : identifiant saisi à l'étape 1 d'une connexion en deux temps

// Démarrage en deux temps. `quick` : de quoi remplir les pages en quelques ms — préférences, profil et
// instantané léger du coffre (entrées sans icônes, une seule valeur chiffrée). `ready` : coffre complet
// (cache de plusieurs Mo avec les icônes, entrées déchiffrées une à une), session serveur.
let session = {};
let loaded = false; // cache complet lu : l'instantané ne doit plus remplacer les entrées
let settled = false; // démarrage terminé (coffre complet, session serveur reprise)
const small = Promise.all([
  chrome.storage.local.get(['prefs', 'profile', 'lite', 'vaultGen', 'lastUsed', 'persist']),
  chrome.storage.session.get(['rawKey', 'token', 'auth', 'pending', 'refused', 'lastUser']),
]);
const fast = (async () => {
  const [l, s] = await small;
  mark('prefs');
  prefs = { ...DEFAULT_PREFS, ...l.prefs };
  applyActionMode().catch(() => {});
  vaultGen = l.vaultGen || 0;
  liteGen = l.lite?.gen ?? -1;
  pending = s.pending || {};
  refused = s.refused || {};
  lastUser = s.lastUser || {};
  lastUsed = l.lastUsed || {};
  session = !s.rawKey && prefs.lock < 0 ? { ...s, ...l.persist } : s; // redémarrage du navigateur
  vault.profile = l.profile || null;
  if (!session.rawKey || !vault.profile) return true; // verrouillé : l'état suffit
  if (liteGen !== vaultGen) return false;
  try {
    const key = await importVaultKey(unb64(session.rawKey), false);
    const items = await decryptItem(key, 'lite', l.lite.enc);
    if (loaded) return true;
    vault.key = key;
    vault.items = new Map(items.map((it) => [it._id, it]));
    mark('lite');
    return true;
  } catch {
    return false;
  }
})();

const ready = (async () => {
  await small; // fast a déjà lu préférences et session (sa suite s'exécute avant celle-ci)
  await vault.load();
  loaded = true;
  mark('load');
  if (session.rawKey && vault.profile) {
    try {
      await vault.resume(session.rawKey, session.token, session.auth || null);
      mark('resume');
      await persistSession();
      if (liteGen !== vaultGen) scheduleLite(); // plus tard : ne pas retarder les premières demandes
    } catch {
      await lockVault();
    }
  } else vault.lock();
  updateBadge();
  settled = true;
  mark('ready');
})();
const quick = fast.then((ok) => (ok ? null : ready));

// Instantané léger : les entrées sans leurs icônes (~10 Ko chacune), chiffrées d'un bloc avec la clé du
// coffre (comme le cache). Réécrit peu après chaque écriture du cache. Seules restent les icônes des
// premières lignes du popup et des dernières entrées remplies (_ic : icône laissée dans le coffre complet).
const LITE_ICONS = 40;
let liteTimer = 0;
function scheduleLite(delay = 1500) {
  clearTimeout(liteTimer);
  liteTimer = setTimeout(() => writeLite().catch(() => {}), delay);
}
async function writeLite() {
  if (!vault.unlocked || !vault.cache.rev && !vault.items.size) return;
  const gen = vaultGen;
  const all = vault.list();
  const keep = new Set([...search(all, '').slice(0, 16).map((it) => it._id), ...Object.values(lastUsed).reverse()].slice(0, LITE_ICONS));
  const items = all.map(({ icon, _fz, _fn, ...it }) => (icon ? (keep.has(it._id) ? { ...it, icon } : { ...it, _ic: 1 }) : it));
  const enc = await encryptItem(vault.key, 'lite', items);
  if (gen !== vaultGen) return; // cache réécrit entre-temps : un autre instantané est prévu
  await chrome.storage.local.set({ lite: { gen, enc } });
  liteGen = gen;
}

// Service worker gardé actif tant que le coffre est ouvert. Chrome l'arrête après 30 s sans activité, et
// chaque réveil coûte ~200 ms (lecture et déchiffrement du coffre) au popup comme au premier remplissage
// d'une page. Un appel d'API repousse cet arrêt (Chrome 110+) ; coffre verrouillé : rien n'est retenu.
setInterval(() => { if (vault.unlocked) chrome.runtime.getPlatformInfo(() => {}); }, 20000);

// ------------------------------------------------------------------ état

async function persistSession() {
  if (!vault.unlocked) return;
  const s = { rawKey: vault.rawKey, token: vault.api.token, auth: vault.auth };
  await chrome.storage.session.set(s);
  if (prefs.lock < 0) await storage.set('persist', s);
  else await storage.remove('persist');
}

async function lockVault() {
  vault.lock();
  pending = {};
  refused = {};
  await chrome.storage.session.clear();
  await storage.remove('persist');
  chrome.alarms.clear('autolock');
  updateBadge();
}

function touch() {
  if (vault.unlocked && prefs.lock > 0) chrome.alarms.create('autolock', { delayInMinutes: prefs.lock });
}

function updateBadge() {
  chrome.action.setBadgeText({ text: vault.unlocked ? '' : '•' });
  chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
  chrome.action.setTitle({ title: vault.unlocked ? `BioPass — ${vault.profile?.user}` : 'BioPass — verrouillé' });
}

// Exécute une opération serveur ; si la session a expiré (401) ou n'existe pas (déverrouillé hors
// ligne), se reconnecte sans mot de passe puis réessaie. Verrouille si le mot de passe a changé.
async function withSession(fn) {
  if (!vault.api.token && vault.auth) {
    try {
      await vault.relogin();
      await persistSession();
    } catch (e) {
      if (e.status === 401) await lockVault();
      if (e.status !== 0) throw e;
    }
  }
  try {
    return await fn();
  } catch (e) {
    if (e.status !== 401) throw e;
    try {
      if (!(await vault.relogin())) throw e;
    } catch (e2) {
      if (e2.status === 401 || e2 === e) await lockVault();
      throw e2;
    }
    await persistSession();
    return fn();
  }
}

async function syncNow() {
  if (!vault.unlocked || (!vault.api.token && !vault.auth)) return false;
  return withSession(() => vault.sync());
}

chrome.alarms.create('sync', { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener(async (a) => {
  await ready;
  if (a.name === 'autolock') await lockVault();
  if (a.name === 'sync') syncNow().then(() => backgroundIcons()).catch(() => {});
});

// ------------------------------------------------------------------ remplissage

const summary = (it) => ({ id: it._id, name: it.name || hostOf(it.uris?.[0]) || '(sans nom)', username: it.username || '', hasPw: !!it.password, hasTotp: !!it.totp, icon: it.icon || '', tone: it.iconTone || '' });

// Icônes des sites manquantes : en arrière-plan, quelques sites à la fois (ne ralentit rien).
let iconsRunning = false;
function backgroundIcons(limit = 15) {
  if (iconsRunning || !vault.unlocked || !vault.api.token) return;
  iconsRunning = true;
  vault.fetchIcons({ limit }).catch(() => {}).finally(() => { iconsRunning = false; });
}

// Dernière entrée remplie par site (domaine de base → id), pour que Ctrl+Espace et le menu
// proposent d'abord le compte utilisé la dernière fois. Aucune donnée secrète.
let lastUsed = {};
function markUsed(url, id) {
  const d = baseDomain(hostOf(url));
  if (!d || lastUsed[d] === id) return;
  delete lastUsed[d]; // en dernier : les plus récents gardent leur icône dans l'instantané léger
  lastUsed[d] = id;
  storage.set('lastUsed', lastUsed);
}

// Domaines de base des adresses d'une entrée, calculés une fois (une entrée modifiée est un nouvel objet) :
// la recherche des comptes d'un site ne réanalyse plus toutes les adresses du coffre à chaque focus.
const domainsOf = new WeakMap();
function domains(it) {
  let d = domainsOf.get(it);
  if (!d) domainsOf.set(it, (d = new Set((it.uris || []).map((u) => baseDomain(hostOf(u))))));
  return d;
}

// Entrées du site : la dernière utilisée d'abord, puis favorites, puis les plus récentes.
function matchesFor(url) {
  if (!vault.unlocked || !/^https?:/.test(url || '')) return [];
  const d = baseDomain(hostOf(url));
  const last = lastUsed[d];
  // portée « hôte » : pas de préfiltre (un hôte saisi peut être lui-même un suffixe public)
  return vault.list().filter((it) => (it.password || it.username || it.totp) && (it.match === 'host' || domains(it).has(d)) && matchesUrl(it, url))
    .sort((a, b) => ((b._id === last) - (a._id === last)) || (b.fav - a.fav) || (b.updated || 0) - (a.updated || 0));
}

async function credsFor(it) {
  let code = '';
  if (it.totp) {
    try { code = (await totp(it.totp)).code; } catch {}
  }
  return { username: it.username || '', password: it.password || '', totp: code };
}

// Demande à toutes les frames de l'onglet de remplir (popup, raccourci clavier).
// first : sans id, remplir directement le premier compte proposé à la frame (pas de liste).
async function autofillTab(tab, id = null, force = false, first = false) {
  const nonce = newId();
  nonces.set(nonce, { tabId: tab.id, expires: Date.now() + 10000 });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'autofill', id, nonce, force, first });
  } catch {
    throw new Error('Impossible de remplir cette page');
  }
}

// Raccourci : premier compte du site, puis le suivant à chaque nouvel appui (dans les 15 s).
const cycle = {}; // tabId → { url, i, t }
// Ctrl+Espace : jamais de liste. Remplit le dernier compte utilisé sur ce site ; si le champ
// identifiant contient encore exactement ce que l'appui précédent y a mis, passe au compte suivant
// (on enchaîne les appuis pour choisir). Formulaire dans une iframe : repli sur un délai de 15 s.
async function fillNext(tab) {
  const c = cycle[tab.id];
  let again = false;
  if (c && c.url === tab.url) {
    const current = await chrome.tabs.sendMessage(tab.id, { type: 'currentUser' }, { frameId: 0 }).catch(() => null);
    const prev = vault.items.get(c.ids[c.i]);
    again = current == null ? Date.now() - c.t < 15000 : !!prev && current === (prev.username || '');
  }
  const ids = again ? c.ids : matchesFor(tab.url).map((it) => it._id); // ordre figé pendant le défilement
  if (!ids.length) return autofillTab(tab, null, false, true); // formulaire dans une iframe d'un autre domaine
  const i = again ? (c.i + 1) % ids.length : 0;
  cycle[tab.id] = { url: tab.url, ids, i, t: Date.now() };
  await autofillTab(tab, ids[i]);
  const it = vault.items.get(ids[i]);
  if (ids.length > 1 && it) notify(tab, `Compte ${i + 1}/${ids.length} : ${it.username || it.name}`);
}

function notify(tab, text) {
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'toast', text }, { frameId: 0 }).catch(() => {});
}

// ------------------------------------------------------------------ presse-papiers (document hors écran)

async function clipboardWrite(text) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Copier un mot de passe généré (raccourci clavier)',
    });
  }
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
}

// Le presse-papiers n'est jamais vidé automatiquement (choix délibéré). Ancien effacement programmé
// par une version précédente : annulé.
chrome.alarms.clear('clipclear');

// ------------------------------------------------------------------ enregistrement après connexion

async function savePending() {
  await chrome.storage.session.set({ pending, refused, lastUser });
}

function pickPassword(values) {
  // [ancien, nouveau, confirmation] ou [nouveau, confirmation] → la valeur répétée, sinon la dernière
  const counts = values.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map());
  return [...counts].find(([, n]) => n > 1)?.[0] ?? values[values.length - 1];
}

async function captured(msg, sender) {
  if (!vault.unlocked || !prefs.savePrompt || !sender.tab) return;
  const url = sender.url;
  if (!/^https?:/.test(url)) return;
  const domain = baseDomain(hostOf(url));
  const values = (msg.passwords || []).filter(Boolean);
  if (!values.length) {
    if (msg.username) {
      lastUser[sender.tab.id] = { user: msg.username, domain, t: Date.now() };
      await savePending();
    }
    return;
  }
  const password = pickPassword(values);
  let username = msg.username || '';
  const lu = lastUser[sender.tab.id];
  if (!username && lu && lu.domain === domain && Date.now() - lu.t < 600000) username = lu.user;

  // comptes existants du site : proposés dans le bandeau (« Modifier »), jamais choisis d'office —
  // sauf celui dont l'identifiant correspond exactement à celui saisi, présélectionné
  const matches = matchesFor(url);
  const same = username ? matches.find((it) => (it.username || '').toLowerCase() === username.toLowerCase()) : null;
  if (same ? same.password === password : matches.some((it) => it.password === password)) return;

  // déjà proposé et bandeau encore ouvert : le recréer ferait perdre ce qui y a été saisi
  const open = pendingFor(sender.tab.id);
  if (open && open.password === password && open.username === username) return;
  if (await isRefused(sender.tab.id, domain, pageKey(url), password, msg.weak)) return;

  pending[sender.tab.id] = { id: same?._id || null, ids: matches.slice(0, 20).map((it) => it._id), username, password, url: pageKey(url), t: Date.now() };
  await savePending();
  setTimeout(() => chrome.tabs.sendMessage(sender.tab.id, { type: 'pending' }, { frameId: 0 }).catch(() => {}), 700);
}

function pendingFor(tabId) {
  const p = pending[tabId];
  if (!p || Date.now() - p.t > 180000) return null;
  return p;
}

// Empreinte plutôt que le mot de passe lui-même : le refus est gardé aussi longtemps que l'onglet.
async function refusalTag(domain, password) {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(domain + '\0' + password))));
}

// « Plus tard » : ce mot de passe n'est plus proposé dans cet onglet, sur tout le domaine, et la page
// reste silencieuse sauf soumission réelle d'un autre mot de passe (nouvel essai, pas une frappe en cours).
async function dismissSave(tabId) {
  const p = pending[tabId];
  delete pending[tabId];
  if (p?.url) {
    const domain = baseDomain(hostOf(p.url));
    const prev = refused[tabId]?.domain === domain ? refused[tabId].tags : [];
    refused[tabId] = { domain, url: p.url, tags: [...prev, await refusalTag(domain, p.password)] };
  }
  await savePending();
}

async function isRefused(tabId, domain, url, password, weak) {
  const r = refused[tabId];
  if (r?.domain !== domain) return false;
  return (weak && r.url === url) || r.tags.includes(await refusalTag(domain, password));
}

// `id` : compte existant (parmi ceux proposés) dont le mot de passe est remplacé ; sinon nouvelle entrée avec
// `match` (domain | host | exact), l'adresse et l'identifiant, éventuellement corrigés, choisis dans le bandeau
async function confirmSave(tabId, msg = {}) {
  const p = pendingFor(tabId);
  if (!p) throw new Error('Plus rien à enregistrer');
  let item;
  if (msg.id) {
    const prev = (p.ids || []).includes(msg.id) && vault.items.get(msg.id);
    if (!prev) throw new Error('Compte introuvable');
    item = withHistory(prev, { ...prev, password: p.password });
  } else {
    const match = ['host', 'exact'].includes(msg.match) ? msg.match : 'domain';
    let uri = String(msg.uri ?? p.url ?? p.origin ?? '').trim();
    const scheme = /^http:/i.test(p.url || p.origin || '') ? 'http://' : 'https://';
    if (uri && !/^https?:\/\//i.test(uri)) uri = scheme + uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    if (!hostOf(uri)) throw new Error('Adresse invalide');
    const username = typeof msg.username === 'string' ? msg.username.trim() : p.username;
    item = { type: 'login', name: hostOf(uri).replace(/^www\./, ''), username, password: p.password, uris: [uri] };
    if (match !== 'domain') item.match = match;
  }
  await withSession(() => vault.save([{ item }]));
  delete pending[tabId];
  await savePending();
}

// ------------------------------------------------------------------ clés d'accès (cf. page.js)
// Demandes de la frame principale seulement ; rpId vérifié contre l'adresse de l'onglet et origine
// (signée dans clientDataJSON) fournie par le navigateur, jamais par la page.

const pkOrigin = (sender) => (sender.origin && sender.origin !== 'null' ? sender.origin : new URL(sender.url).origin);
const pkAllowed = (msg, sender) => sender.frameId === 0 && rpIdAllowed(msg.rpId, sender.url);

function passkeysFor(rpId) {
  rpId = rpId.toLowerCase();
  return vault.list().flatMap((it) => (it.passkeys || []).filter((pk) => pk.rpId?.toLowerCase() === rpId).map((pk) => ({ it, pk })));
}

function pkQuery(msg, sender) {
  if (!vault.profile || !pkAllowed(msg, sender)) return { native: true };
  if (!vault.unlocked) return { locked: true };
  touch();
  const keys = passkeysFor(msg.rpId);
  if (msg.op === 'create') {
    if (keys.some(({ pk }) => (msg.exclude || []).includes(pk.credentialId))) return { excluded: true };
    return { entries: matchesFor(sender.url).map((it) => ({ id: it._id, name: it.name || hostOf(it.uris?.[0]), username: it.username || '' })) };
  }
  const allow = msg.allow || [];
  const candidates = keys.filter(({ pk }) => !allow.length || allow.includes(pk.credentialId)).map(({ it, pk }) => ({
    itemId: it._id, credentialId: pk.credentialId, name: it.name || pk.rpName || pk.rpId,
    userName: pk.userName || pk.userDisplayName || it.username || '', icon: it.icon || '', tone: it.iconTone || '',
  }));
  return candidates.length ? { candidates } : { native: true };
}

async function pkCreate(msg, sender) {
  if (!pkAllowed(msg, sender)) throw new Error('Site non autorisé');
  if (!vault.unlocked) throw new Error('BioPass est verrouillé');
  const rpId = msg.rpId.toLowerCase();
  const origin = pkOrigin(sender);
  const { passkey, response } = await createPasskey({ rpId, rpName: msg.rpName || '', user: msg.user, challenge: msg.challenge, origin });
  const base = msg.target && vault.items.get(msg.target);
  // même compte (rpId + identifiant utilisateur) : la nouvelle clé remplace l'ancienne
  const item = base
    ? { ...base, passkeys: [...(base.passkeys || []).filter((p) => !(p.rpId === rpId && p.userHandle === passkey.userHandle)), passkey] }
    : { type: 'login', name: msg.rpName || hostOf(origin).replace(/^www\./, ''), username: msg.user.name || '', uris: [origin], passkeys: [passkey] };
  await withSession(() => vault.save([{ item }]));
  return response;
}

async function pkGet(msg, sender) {
  if (!pkAllowed(msg, sender)) throw new Error('Site non autorisé');
  if (!vault.unlocked) throw new Error('BioPass est verrouillé');
  const it = vault.items.get(msg.itemId);
  const pk = it?.passkeys?.find((p) => p.credentialId === msg.credentialId && p.rpId?.toLowerCase() === msg.rpId.toLowerCase());
  if (!pk) throw new Error('Clé d\'accès introuvable');
  touch();
  const { counter, response } = await signPasskey(pk, { challenge: msg.challenge, origin: pkOrigin(sender) });
  if (counter) { // compteur importé de Bitwarden : à faire progresser à chaque connexion
    const item = { ...it, passkeys: it.passkeys.map((p) => (p === pk ? { ...p, counter } : p)) };
    await withSession(() => vault.save([{ item }], { touch: false })).catch(() => {});
  }
  markUsed(sender.tab?.url || sender.url, it._id);
  return response;
}

// ------------------------------------------------------------------ messages

const fromExtension = (sender) => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));

async function openPopup() {
  if (prefs.window) return openWindow();
  try {
    await chrome.action.openPopup();
  } catch {
    await openWindow();
  }
}

// BioPass dans une vraie fenêtre, centrée sur celle du navigateur (une seule à la fois). Contrairement à
// la bulle de la barre d'outils, une fenêtre reçoit les séquences Compose (macros clavier type keyd),
// que Brave sous Wayland ne transmet pas aux bulles d'extension.
async function openWindow() {
  const url = chrome.runtime.getURL('popup.html?window=1');
  const [open] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (open) return chrome.windows.update(open.windowId, { focused: true });
  const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const width = 400;
  const height = 620;
  const pos = w?.width ? { left: Math.round(w.left + (w.width - width) / 2), top: Math.round(w.top + Math.max(0, (w.height - height) / 3)) } : {};
  await chrome.windows.create({ url, type: 'popup', width, height, ...pos });
}

// Icône de la barre d'outils : bulle, ou fenêtre si l'option est choisie (onClicked n'est appelé que sans bulle)
const applyActionMode = () => chrome.action.setPopup({ popup: prefs.window ? '' : 'popup.html' });
chrome.action.onClicked.addListener(() => openWindow().catch(() => {}));

async function handleContent(msg, sender) {
  switch (msg.type) {
    case 'state':
      return { configured: !!vault.profile, unlocked: vault.unlocked, inline: prefs.inline };
    case 'focus': // champ de connexion touché : état et comptes du site en un seul aller-retour
      return { configured: !!vault.profile, unlocked: vault.unlocked, inline: prefs.inline,
        matches: vault.unlocked && prefs.inline ? matchesFor(sender.url).map(summary) : [] };
    case 'matches':
      return matchesFor(sender.url).map(summary);
    case 'creds': {
      const it = vault.items.get(msg.id);
      if (!it) return null;
      const n = msg.nonce && nonces.get(msg.nonce);
      const forced = n && n.tabId === sender.tab?.id && n.expires > Date.now() && msg.force && sender.frameId === 0;
      if (!matchesUrl(it, sender.url) && !forced) return null;
      touch();
      markUsed(sender.tab?.url || sender.url, it._id);
      return credsFor(it);
    }
    case 'captured':
      return captured(msg, sender);
    case 'pending': {
      const p = sender.frameId === 0 && pendingFor(sender.tab.id);
      if (!p) return null;
      // valeurs proposées pour chaque portée de correspondance (cf. matchesUrl) ; port conservé pour le lien
      const u = p.url && new URL(p.url);
      const host = u && u.hostname.replace(/^www\./, '');
      const port = u?.port ? ':' + u.port : '';
      const domain = u && baseDomain(host);
      const sites = u ? { domain: domain + (domain === host ? port : ''), host: host + port, exact: p.url.replace(/^https?:\/\//, '') } : null;
      const accounts = (p.ids || []).map((id) => vault.items.get(id)).filter(Boolean).map(summary);
      const id = accounts.some((a) => a.id === p.id) ? p.id : null;
      return { id, name: host || '', username: p.username, password: p.password, sites, accounts };
    }
    case 'pkQuery':
      return pkQuery(msg, sender);
    case 'pkCreate':
      return pkCreate(msg, sender);
    case 'pkGet':
      return pkGet(msg, sender);
    case 'generate':
      return generatePassword({ length: 20 });
    case 'confirmSave':
      return confirmSave(sender.tab.id, msg);
    case 'dismissSave':
      return dismissSave(sender.tab.id);
    case 'openPopup':
      return openPopup();
  }
  throw new Error('Message inconnu');
}

const statusOf = () => ({
  configured: !!vault.profile, unlocked: vault.unlocked, online: vault.online && !!vault.api.token,
  user: vault.profile?.user, server: vault.profile?.server, prefs,
});

async function handleExtension(msg) {
  switch (msg.type) {
    case 'perf':
      return boot;
    case 'status':
      return statusOf();
    case 'login':
      await vault.login(msg.server, msg.user, msg.password);
      await persistSession();
      touch();
      updateBadge();
      setTimeout(() => backgroundIcons(), 3000);
      return true;
    case 'unlock':
      await vault.unlock(msg.password);
      await persistSession();
      touch();
      updateBadge();
      setTimeout(() => backgroundIcons(), 3000);
      return true;
    case 'openWindow':
      return openWindow();
    case 'lock':
      return lockVault();
    case 'forget':
      await lockVault();
      await vault.forget();
      return true;
    case 'popup': {
      // Ouverture du popup, en un seul aller-retour : état, onglet de la page, liste allégée et icônes des
      // premières lignes affichées. La liste ne porte que ce qui est affiché ou cherché : ni mots de
      // passe, ni notes, ni autres icônes (demandés au besoin).
      const status = statusOf();
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
      const [tab] = w ? await chrome.tabs.query({ active: true, windowId: w.id }) : [];
      const page = tab ? { id: tab.id, url: tab.url || '' } : null;
      if (!vault.unlocked) return { status, tab: page };
      // Service worker juste réveillé : liste tirée de l'instantané léger, sans attendre le coffre complet
      // (les icônes manquantes suivent). La session serveur n'est pas encore reprise : pas « hors ligne ».
      const partial = !settled || undefined;
      if (partial) status.online = !!session.token;
      touch();
      const all = vault.list();
      const first = [...(page ? all.filter((it) => matchesUrl(it, page.url)) : []), ...search(all, '').slice(0, msg.first || 0)];
      return {
        status,
        tab: page,
        list: all.map((it) => ({
          _id: it._id, name: it.name, username: it.username, uris: it.uris, folder: it.folder, fav: it.fav,
          hasPw: !!it.password, totp: !!it.totp, kind: entryKind(it), iconTone: it.iconTone, iconLazy: it.icon || it._ic ? 1 : undefined,
        })),
        partial,
        icons: Object.fromEntries(first.filter((it) => it.icon).map((it) => [it._id, it.icon])),
      };
    }
    case 'item': { // entrée complète (éditeur du popup)
      const { _fz, _fn, ...it } = vault.items.get(msg.id) || {};
      return it._id ? it : null;
    }
    case 'secret': // un champ d'une entrée, au moment de le copier
      touch();
      return vault.items.get(msg.id)?.[msg.field === 'username' ? 'username' : 'password'] || '';
    case 'list':
      // sans les icônes (128 px : plusieurs Mo pour tout le coffre) : la popup demande celles qu'elle affiche
      touch();
      return vault.list().map(({ _fz, _fn, icon, ...it }) => (icon ? { ...it, iconLazy: 1 } : it));
    case 'icons':
      return Object.fromEntries(msg.ids.map((id) => [id, vault.items.get(id)?.icon || '']));
    case 'sync':
      return syncNow();
    case 'totp':
      return (await totp(vault.items.get(msg.id)?.totp)).code;
    case 'fill': {
      touch();
      const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab) throw new Error('Aucun onglet actif');
      await autofillTab(tab, msg.id, !!msg.force);
      return true;
    }
    case 'save': {
      touch();
      const { iconLazy, ...item } = msg.item;
      if (iconLazy && !item.icon) item.icon = vault.items.get(item._id)?.icon; // icône non chargée par la popup
      const [id] = await withSession(() => vault.save([{ item }]));
      if (!vault.items.get(id)?.icon) vault.fetchIcons({ ids: [id], limit: 1 }).catch(() => {}); // en arrière-plan
      return id;
    }
    case 'delete':
      touch();
      return withSession(() => vault.save([{ id: msg.id, del: true }]));
    case 'command': // mêmes actions que les raccourcis clavier
      return runCommand(msg.name, msg.tabId ? await chrome.tabs.get(msg.tabId) : undefined);
    case 'checkUpdate': { // bouton « Rechercher une mise à jour »
      // Dernière version publiée par le serveur (update.xml), puis demande au navigateur de l'installer.
      const current = chrome.runtime.getManifest().version;
      const updateUrl = chrome.runtime.getManifest().update_url; // posé par build-server.sh (contient la clé)
      let latest = null;
      if (updateUrl) {
        try {
          const res = await fetch(updateUrl, { cache: 'no-store' });
          latest = (await res.text()).match(/<updatecheck\b[^>]*\bversion='([\d.]+)'/)?.[1] || null; // pas l'en-tête <?xml version='1.0'?>
        } catch {}
      }
      const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
      if (latest && !newer(latest, current)) return { status: 'no_update', current, latest };
      const [status] = await new Promise((r) => chrome.runtime.requestUpdateCheck((s) => r([s])));
      return { status, current, latest };
    }
    case 'prefs':
      prefs = { ...prefs, ...msg.prefs };
      await storage.set('prefs', prefs);
      await applyActionMode();
      if (prefs.lock > 0) touch();
      else chrome.alarms.clear('autolock');
      await persistSession(); // ajoute ou retire la conservation sur disque
      return prefs;
  }
  throw new Error('Message inconnu');
}

// Messages des pages pour remplir : servis dès l'instantané léger chargé, sans attendre le coffre complet
const QUICK = new Set(['state', 'focus', 'matches', 'creds']);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    // 'command' (popup, banc de mesure) : runCommand attend lui-même ce qu'il lui faut
    const early = msg.type === 'command' || (msg.type === 'popup' && fromExtension(sender)) || (QUICK.has(msg.type) && sender.tab && !fromExtension(sender));
    await (early ? quick : ready);
    return fromExtension(sender) ? handleExtension(msg) : sender.tab ? handleContent(msg, sender) : null;
  })().then((data) => reply({ data }), (e) => reply({ error: e.message || String(e), status: e.status }));
  return true;
});

// ------------------------------------------------------------------ raccourci clavier et menu contextuel

chrome.commands.onCommand.addListener((cmd, tab) => runCommand(cmd, tab));

async function runCommand(cmd, tab) {
  await (cmd === 'autofill' ? quick : ready);
  tab ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (cmd === 'generate') {
    await clipboardWrite(generatePassword({ length: 20 }));
    return notify(tab, 'Mot de passe généré copié');
  }
  if (cmd !== 'autofill') return;
  if (!vault.unlocked) return openPopup();
  if (tab) await fillNext(tab).catch(() => {});
}

// Onglets déjà ouverts sans script de contenu actif : onglets restaurés au lancement du navigateur avant
// que l'extension soit prête, ou scripts devenus orphelins après une mise à jour. Sans cela, il faudrait
// recharger la page pour pouvoir remplir. `replace` : retire d'abord l'ancienne instance (mise à jour).
async function injectOpenTabs(replace) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'], discarded: false });
  await Promise.all(tabs.map(async (tab) => {
    const target = { tabId: tab.id, allFrames: true };
    try {
      if (replace) await chrome.scripting.executeScript({ target, func: () => window.__biopass?.teardown?.() });
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
    } catch {} // page interdite (boutique d'extensions…) ou onglet fermé entre-temps
  }));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'bp-fill', title: 'Remplir avec BioPass', contexts: ['editable'] });
  chrome.contextMenus.create({ id: 'bp-gen', title: 'Générer un mot de passe ici', contexts: ['editable'] });
  injectOpenTabs(true).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => injectOpenTabs(false).catch(() => {}));

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await ready;
  if (!tab) return;
  if (info.menuItemId === 'bp-fill') {
    if (!vault.unlocked) return openPopup();
    autofillTab(tab).catch(() => {});
  } else if (info.menuItemId === 'bp-gen') {
    chrome.tabs.sendMessage(tab.id, { type: 'generate' }, { frameId: info.frameId ?? 0 }).catch(() => {});
  }
});

// Mise à jour téléchargée : l'appliquer tout de suite (sinon le navigateur attend que l'extension
// soit inactive, ce qui peut ne jamais arriver). La clé est reprise si « Jamais » est choisi.
chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload());

chrome.tabs.onRemoved.addListener((tabId) => {
  delete pending[tabId];
  delete refused[tabId];
  delete lastUser[tabId];
});
