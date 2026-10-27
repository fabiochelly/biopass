// BioPass — service worker de l'extension.
// La clé du coffre vit en mémoire (chrome.storage.session, jamais écrite sur disque) ;
// le cache chiffré est dans chrome.storage.local. Les mots de passe ne sont transmis
// à une page que si le domaine de la frame qui les demande correspond à l'entrée.
import { Vault, matchesUrl, totp, hostOf, baseDomain, newId, generatePassword, withHistory, entryKind, search } from './lib/core.js';

// Repères du démarrage (ms depuis le lancement du service worker), lus par tools/bench-extension.mjs.
const boot = { started: Date.now() - Math.round(performance.now()), imports: Math.round(performance.now()) };
const mark = (k) => { boot[k] = Math.round(performance.now()); };

const storage = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  remove: (k) => chrome.storage.local.remove(k),
};

const vault = new Vault(storage, { keepRaw: true });
// lock : minutes d'inactivité avant verrouillage ; 0 = à la fermeture du navigateur ;
// -1 = jamais (clé conservée sur disque, reconnexion automatique au serveur).
const DEFAULT_PREFS = { lock: -1, inline: true, savePrompt: true, window: false };
let prefs = { ...DEFAULT_PREFS };
const nonces = new Map(); // nonce → { tabId, expires } : autorise un remplissage forcé demandé par l'utilisateur
let pending = {}; // tabId → proposition d'enregistrement
let lastUser = {}; // tabId → { user, domain, t } : identifiant saisi à l'étape 1 d'une connexion en deux temps

const ready = (async () => {
  prefs = { ...DEFAULT_PREFS, ...(await storage.get('prefs')) };
  mark('prefs');
  applyActionMode().catch(() => {});
  await vault.load();
  mark('load');
  let s = await chrome.storage.session.get(['rawKey', 'token', 'auth', 'pending', 'lastUser']);
  pending = s.pending || {};
  lastUser = s.lastUser || {};
  lastUsed = (await storage.get('lastUsed')) || {};
  if (!s.rawKey && prefs.lock < 0) s = { ...s, ...(await storage.get('persist')) }; // redémarrage du navigateur
  if (s.rawKey && vault.profile) {
    try {
      await vault.resume(s.rawKey, s.token, s.auth || null);
      mark('resume');
      await persistSession();
    } catch {
      await lockVault();
    }
  }
  updateBadge();
  mark('ready');
})();

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
  if (a.name === 'clipclear') clipboardWrite('').catch(() => {});
  if (a.name === 'sync') syncNow().then(() => backgroundIcons()).catch(() => {});
});

// ------------------------------------------------------------------ remplissage

const summary = (it) => ({ id: it._id, name: it.name || hostOf(it.uris?.[0]) || '(sans nom)', username: it.username || '', hasTotp: !!it.totp, icon: it.icon || '', tone: it.iconTone || '' });

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
  lastUsed[d] = id;
  storage.set('lastUsed', lastUsed);
}

// Entrées du site : la dernière utilisée d'abord, puis favorites, puis les plus récentes.
function matchesFor(url) {
  if (!vault.unlocked || !/^https?:/.test(url || '')) return [];
  const last = lastUsed[baseDomain(hostOf(url))];
  return vault.list().filter((it) => it.password || it.username || it.totp).filter((it) => matchesUrl(it, url))
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
      url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Copier un mot de passe généré et vider le presse-papiers ensuite',
    });
  }
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
}

function scheduleClipboardClear() {
  chrome.alarms.create('clipclear', { delayInMinutes: 0.5 });
}

// ------------------------------------------------------------------ enregistrement après connexion

async function savePending() {
  await chrome.storage.session.set({ pending, lastUser });
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

  const matches = matchesFor(url);
  const same = matches.find((it) => (it.username || '').toLowerCase() === username.toLowerCase())
    || (!username && matches.length === 1 ? matches[0] : null);
  if (same && same.password === password) return;
  if (!same && matches.some((it) => it.password === password)) return;

  const origin = new URL(url).origin;
  pending[sender.tab.id] = {
    kind: same ? 'update' : 'add', id: same?._id || null, name: same?.name || hostOf(url).replace(/^www\./, ''),
    username: same ? same.username : username, password, origin, t: Date.now(),
  };
  await savePending();
  setTimeout(() => chrome.tabs.sendMessage(sender.tab.id, { type: 'pending' }, { frameId: 0 }).catch(() => {}), 700);
}

function pendingFor(tabId) {
  const p = pending[tabId];
  if (!p || Date.now() - p.t > 180000) return null;
  return p;
}

async function confirmSave(tabId) {
  const p = pendingFor(tabId);
  if (!p) throw new Error('Plus rien à enregistrer');
  let item;
  if (p.kind === 'update' && vault.items.get(p.id)) {
    item = withHistory(vault.items.get(p.id), { ...vault.items.get(p.id), password: p.password });
  } else {
    item = { type: 'login', name: p.name, username: p.username, password: p.password, uris: [p.origin] };
  }
  await withSession(() => vault.save([{ item }]));
  delete pending[tabId];
  await savePending();
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
      return p ? { kind: p.kind, name: p.name, username: p.username } : null;
    }
    case 'generate':
      return generatePassword({ length: 20 });
    case 'confirmSave':
      return confirmSave(sender.tab.id);
    case 'dismissSave':
      delete pending[sender.tab.id];
      return savePending();
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
      touch();
      const all = vault.list();
      const first = [...(page ? all.filter((it) => matchesUrl(it, page.url)) : []), ...search(all, '').slice(0, msg.first || 0)];
      return {
        status,
        tab: page,
        list: all.map((it) => ({
          _id: it._id, name: it.name, username: it.username, uris: it.uris, folder: it.folder, fav: it.fav,
          hasPw: !!it.password, totp: !!it.totp, kind: entryKind(it), iconTone: it.iconTone, iconLazy: it.icon ? 1 : undefined,
        })),
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
          latest = (await res.text()).match(/version='([\d.]+)'/)?.[1] || null;
        } catch {}
      }
      const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
      if (latest && !newer(latest, current)) return { status: 'no_update', current, latest };
      const [status] = await new Promise((r) => chrome.runtime.requestUpdateCheck((s) => r([s])));
      return { status, current, latest };
    }
    case 'clipboardCopied': // copie faite par la popup : effacer dans 30 s
      return scheduleClipboardClear();
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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    return fromExtension(sender) ? handleExtension(msg) : sender.tab ? handleContent(msg, sender) : null;
  })().then((data) => reply({ data }), (e) => reply({ error: e.message || String(e), status: e.status }));
  return true;
});

// ------------------------------------------------------------------ raccourci clavier et menu contextuel

chrome.commands.onCommand.addListener((cmd, tab) => runCommand(cmd, tab));

async function runCommand(cmd, tab) {
  await ready;
  tab ??= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (cmd === 'generate') {
    await clipboardWrite(generatePassword({ length: 20 }));
    scheduleClipboardClear();
    return notify(tab, 'Mot de passe généré copié (effacé dans 30 s)');
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
  delete lastUser[tabId];
});
