// BioPass — application web (PWA). Données déchiffrées uniquement en mémoire.
import { Vault, search, totp, generatePassword, parseBitwarden, hostOf, withHistory, iconHost, unb64, diffVaults, DIFF_FIELDS, sendPin, entryKind } from './index.php?f=assets/core.js';
import { icon, hydrateIcons, avatarColor, initial, KIND_COLORS, KIND_ICONS } from './index.php?f=assets/icons.js';

const $ = (sel, el = document) => el.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

// Cache local (profil + coffre chiffré) dans IndexedDB : pas de limite de 5 Mo comme localStorage
// (les icônes des sites grossissent le coffre). Migration automatique depuis localStorage.
const idb = (() => {
  let db = null;
  const open = () => (db ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('biopass', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const run = async (mode, fn) => {
    const tx = (await open()).transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)),
    del: (k) => run('readwrite', (s) => s.delete(k)),
  };
})();

const storage = {
  async get(k) {
    try {
      const v = await idb.get(k);
      if (v !== undefined) return v;
    } catch {}
    let v = null;
    try { v = JSON.parse(localStorage.getItem('bp.' + k)); } catch {}
    if (v != null) {
      try { await idb.set(k, v); localStorage.removeItem('bp.' + k); } catch {}
    }
    return v;
  },
  async set(k, v) {
    try {
      await idb.set(k, v);
    } catch {
      localStorage.setItem('bp.' + k, JSON.stringify(v)); // navigation privée sans IndexedDB
    }
  },
  async remove(k) {
    try { await idb.del(k); } catch {}
    localStorage.removeItem('bp.' + k);
  },
};

const vault = new Vault(storage, { keepRaw: true });
let prefs = { lock: 15, gen: { length: 20, upper: true, digits: true, symbols: true } };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem('bp.prefs') || '{}') }; } catch {}
const savePrefs = () => localStorage.setItem('bp.prefs', JSON.stringify(prefs));

const state = { mode: 'login', results: [], cursor: 0, selected: null, lastActive: Date.now(), lastSync: 0 };
let totpTimer = null;

// ------------------------------------------------------------------ utilitaires

function toast(msg, ms = 1800, ok = true) {
  const t = $('#toast');
  t.replaceChildren(ok ? icon('check') : '', msg);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

async function copy(text, label, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return toast('Copie impossible', 2000, false);
  }
  toast(`${label} copié`);
  if (btn) {
    btn.classList.add('done');
    btn.replaceChildren(icon('check'));
    setTimeout(() => { btn.classList.remove('done'); btn.replaceChildren(icon('copy')); }, 1200);
  }
  // le presse-papiers n'est jamais vidé automatiquement (choix délibéré)
}

// Icônes des sites : chaque data: URL devient une blob: URL réutilisée, pour que le navigateur ne
// décode l'image qu'une seule fois même si la liste est redessinée à chaque frappe.
const iconUrls = new Map();
function iconSrc(data) {
  let url = iconUrls.get(data);
  if (!url) {
    url = URL.createObjectURL(new Blob([unb64(data.slice(data.indexOf(',') + 1))], { type: 'image/png' }));
    iconUrls.set(data, url);
  }
  return url;
}

// Avatar d'une entrée : icône du site (brute), sinon icône de catégorie (IP, SSH, Wi-Fi…), sinon initiale.
function avatar(name, siteIcon, it = null) {
  if (siteIcon) return h('div', { class: 'avatar site' + (it?.iconTone ? ' ' + it.iconTone : '') }, h('img', { src: iconSrc(siteIcon), alt: '', decoding: 'async', draggable: false }));
  const kind = it && entryKind(it);
  if (kind) {
    const k = h('div', { class: 'avatar kind' }, icon(KIND_ICONS[kind]));
    k.style.background = KIND_COLORS[kind];
    return k;
  }
  const a = h('div', { class: 'avatar' }, initial(name));
  a.style.background = avatarColor(name);
  return a;
}

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) : '';
const isWide = () => matchMedia('(min-width: 860px)').matches;
const typing = (el) => el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

function iconBtn(name, title, onclick, cls = '') {
  return h('button', { type: 'button', title, class: cls, onclick }, icon(name));
}

function strength(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z\d]/.test(pw)) pool += 20;
  return pw.length * Math.log2(Math.max(pool, 2)); // entropie approximative en bits
}

// ------------------------------------------------------------------ authentification

function showAuth(mode) {
  state.mode = mode;
  const f = $('#auth-form');
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#f-user').hidden = mode === 'unlock';
  $('#reg-fields').hidden = mode !== 'register';
  $('#auth-hello').textContent = mode === 'unlock' ? `Bon retour, ${vault.profile.user}`
    : mode === 'register' ? 'Créez votre coffre chiffré.' : 'Vos mots de passe, chez vous.';
  $('#auth-submit .label').textContent = { unlock: 'Déverrouiller', login: 'Se connecter', register: 'Créer le compte' }[mode];
  $('#auth-toggle').hidden = mode === 'unlock';
  $('#auth-toggle').textContent = mode === 'register' ? 'J\'ai déjà un compte' : 'Créer un compte';
  $('#auth-switch').hidden = mode !== 'unlock';
  $('#auth-error').textContent = '';
  f.password.value = f.password2.value = '';
  f.password.type = 'password';
  f.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  (mode === 'unlock' ? f.password : f.user).focus();
}

$('#auth-toggle').onclick = () => showAuth(state.mode === 'register' ? 'login' : 'register');
$('#auth-switch').onclick = () => showAuth('login');
$('#auth-form [data-act=reveal]').onclick = (e) => {
  const f = $('#auth-form');
  f.password.type = f.password.type === 'password' ? 'text' : 'password';
  e.currentTarget.replaceChildren(icon(f.password.type === 'password' ? 'eye' : 'eyeOff'));
};

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('#auth-submit');
  const err = $('#auth-error');
  err.textContent = '';
  const pw = f.password.value;
  if (state.mode !== 'unlock' && !f.user.value.trim()) return (err.textContent = 'Identifiant requis');
  if (!pw) return (err.textContent = 'Mot de passe requis');
  if (state.mode === 'register') {
    if (pw.length < 5) return (err.textContent = 'Au moins 5 caractères');
    if (pw !== f.password2.value) return (err.textContent = 'Les mots de passe ne correspondent pas');
  }
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    if (state.mode === 'unlock') await vault.unlock(pw);
    else if (state.mode === 'login') await vault.login('.', f.user.value, pw);
    else await vault.register('.', f.user.value, pw, f.code.value.trim());
    f.password.value = f.password2.value = '';
    enterApp();
    saveSession();
  } catch (ex) {
    err.textContent = ex.message;
    f.password.select();
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
};

// ------------------------------------------------------------------ application

function enterApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  state.lastActive = state.lastSync = Date.now();
  $('#q').value = '';
  state.cursor = 0;
  $('#list').classList.add('intro');
  setTimeout(() => $('#list').classList.remove('intro'), 400);
  renderList();
  closeDetail();
  renderStatus();
  if (isWide()) $('#q').focus();
  setTimeout(() => scheduleIcons(), 2000);
}

// ------------------------------------------------------------------ icônes des sites (tâche de fond)
// Rien ne doit ralentir : lancé quand le navigateur est inactif, deux sites à la fois, un nombre
// limité par passage, et la liste n'est redessinée qu'à la fin.
let iconsRunning = false;
let iconsWanted = false; // « Récupérer les icônes » demandé pendant un passage en arrière-plan
function scheduleIcons(opts = {}) {
  if (iconsRunning || !vault.unlocked || !vault.api.token) return;
  iconsRunning = true;
  const run = async () => {
    try {
      const n = await vault.fetchIcons({ limit: 30, ...opts });
      if (n && vault.unlocked) {
        renderList();
        if (state.selected) showDetail(state.selected, false, true);
      }
    } catch {
    } finally {
      iconsRunning = false;
      if (iconsWanted) {
        iconsWanted = false;
        fetchAllIcons();
      }
    }
  };
  (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(run, { timeout: 8000 });
}

async function fetchAllIcons() {
  if (!vault.api.token) return toast('Hors ligne', 2000, false);
  if (iconsRunning) {
    iconsWanted = true; // enchaîne dès la fin du passage en cours (quelques sites)
    return toast('Récupération de toutes les icônes : démarrage dans un instant…', 3000, false);
  }
  iconsRunning = true;
  try {
    // tous les sites sans icône, échecs précédents compris, en une passe (4 à la fois)
    await vault.fetchIcons({ limit: 100000, concurrency: 4, retry: true, onProgress: (done, total) => toast(`Icônes des sites… ${done}/${total}`, 60000, false) });
    const withIcon = vault.list().filter((it) => it.icon).length;
    toast(`${plural(withIcon, 'entrée')} avec icône sur ${vault.items.size}`, 3500);
  } catch (e) {
    toast(e.message, 3000, false);
  } finally {
    iconsRunning = false;
    renderList();
  }
}

// ------------------------------------------------------------------ session d'onglet
// La clé du coffre survit à un rechargement (F5) grâce au stockage de session de l'onglet :
// effacé à la fermeture de l'onglet, au verrouillage et après le délai d'inactivité.

const SESSION = 'bp.session';

function saveSession() {
  if (!vault.unlocked) return;
  try {
    sessionStorage.setItem(SESSION, JSON.stringify({ user: vault.profile.user, raw: vault.rawKey, token: vault.api.token, t: state.lastActive }));
  } catch {}
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION); } catch {}
}

async function resumeSession() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(SESSION)); } catch {}
  if (!s?.raw || !vault.profile || s.user !== vault.profile.user || Date.now() - s.t > prefs.lock * 60000) {
    clearSession();
    return false;
  }
  try {
    await vault.resume(s.raw, s.token);
  } catch {
    clearSession();
    vault.lock();
    return false;
  }
  enterApp();
  doSync();
  return true;
}

window.addEventListener('pagehide', saveSession);

function lock() {
  clearSession();
  vault.lock();
  for (const url of iconUrls.values()) URL.revokeObjectURL(url);
  iconUrls.clear();
  rowCache = new WeakMap();
  clearInterval(totpTimer);
  $('#list').replaceChildren();
  $('#detail').replaceChildren();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  state.results = [];
  state.selected = null;
  showAuth('unlock');
}

function renderStatus() {
  const s = $('#status');
  s.classList.toggle('offline', !vault.online);
  s.textContent = vault.online ? `Synchronisé · ${new Date(state.lastSync).toLocaleTimeString('fr-FR', { timeStyle: 'short' })}` : 'Hors ligne · lecture seule';
  s.title = s.textContent;
  $('#btn-new').disabled = !vault.online;
}

async function doSync(manual = false) {
  if (!vault.unlocked) return;
  try {
    if (!vault.api.token) {
      if (manual) toast('Hors ligne : verrouillez puis déverrouillez une fois connecté', 3000, false);
      return;
    }
    const changed = await vault.sync();
    if (vault.online) state.lastSync = Date.now();
    if (changed) {
      renderList();
      if (state.selected && !vault.items.has(state.selected)) closeDetail();
      else if (state.selected) showDetail(state.selected, false, true);
    }
    if (manual) toast(vault.online ? (changed ? 'Données mises à jour' : 'Déjà à jour') : 'Serveur injoignable', 1800, vault.online);
  } catch (e) {
    if (e.status === 401) {
      toast('Session expirée', 2000, false);
      return lock();
    }
    toast(e.message, 2500, false);
  } finally {
    renderStatus();
  }
}

// ------------------------------------------------------------------ liste

function renderList() {
  const q = $('#q').value;
  state.results = search(vault.list(), q);
  state.cursor = Math.min(state.cursor, Math.max(0, state.results.length - 1));
  $('#list-head').textContent = q ? plural(state.results.length, 'résultat') : plural(vault.items.size, 'entrée');
  const list = $('#list');
  if (!state.results.length) {
    list.replaceChildren(q
      ? h('li', { class: 'empty-state' }, icon('search'), h('b', {}, 'Aucun résultat'), `Rien ne correspond à « ${q} »`)
      : h('li', { class: 'empty-state' }, icon('shield'), h('b', {}, 'Votre coffre est vide'),
        'Ajoutez une entrée avec ＋ ou importez votre export Bitwarden depuis le menu.'));
    return;
  }
  // 40 lignes tout de suite (bien plus que l'écran), le reste quand le navigateur est libre ;
  // une nouvelle frappe annule l'ajout en cours. Les lignes sont réutilisées d'une frappe à l'autre.
  const token = ++renderToken;
  const rows = state.results.slice(0, 500);
  list.replaceChildren(...rows.slice(0, 40).map(placeRow));
  let next = 40;
  const more = (deadline) => {
    if (token !== renderToken || next >= rows.length) return;
    const frag = document.createDocumentFragment();
    do frag.append(placeRow(rows[next], next)); while (++next < rows.length && next % 60 && (!deadline || deadline.timeRemaining() > 2));
    list.append(frag);
    idle(more);
  };
  idle(more);
}

let renderToken = 0;
let rowCache = new WeakMap(); // entrée déchiffrée → <li> (une entrée modifiée est un nouvel objet)
const idle = (f) => (window.requestIdleCallback ? requestIdleCallback(f, { timeout: 200 }) : setTimeout(f, 16));

function placeRow(it, i) {
  let li = rowCache.get(it);
  if (!li) rowCache.set(it, (li = row(it)));
  li.dataset.idx = i;
  li.classList.toggle('cursor', i === state.cursor && isWide());
  li.classList.toggle('active', it._id === state.selected);
  return li;
}

function row(it) {
  const name = it.name || '(sans nom)';
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  const li = h('li', {
    'data-id': it._id,
    onclick: () => { state.cursor = +li.dataset.idx; showDetail(it._id); },
  },
  avatar(name, it.icon, it),
  h('div', { class: 'meta' },
    h('div', { class: 'name' }, h('span', {}, name), it.fav && icon('star')),
    h('div', { class: 'sub' }, it.username || hostOf(it.uris?.[0]) || it.folder || '')),
  h('div', { class: 'quick' },
    it.username && iconBtn('user', 'Copier l\'identifiant', stop(() => copy(it.username, 'Identifiant')), 'q-user'),
    it.password && iconBtn('key', 'Copier le mot de passe', stop(() => copy(it.password, 'Mot de passe')))));
  return li;
}

function moveCursor(delta) {
  if (!state.results.length) return;
  state.cursor = Math.max(0, Math.min(state.results.length - 1, state.cursor + delta));
  const lis = $('#list').children;
  for (const li of lis) li.classList.remove('cursor');
  lis[state.cursor]?.classList.add('cursor');
  lis[state.cursor]?.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------------ détail

function fieldRow(label, value, { secret = false, mono = false, link = false, notes = false, copyLabel } = {}) {
  if (!value) return null;
  const v = h('div', { class: `v${mono || secret ? ' mono' : ''}${notes ? ' notes' : ''}` });
  let visible = !secret;
  const render = () => {
    if (link) {
      const href = /^https?:\/\//i.test(value) ? value : /^[a-z][a-z0-9+.-]*:/i.test(value) ? null : 'https://' + value;
      v.replaceChildren(href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, value) : value);
    } else v.textContent = visible ? value : '•'.repeat(Math.min(value.length, 14));
  };
  render();
  const acts = h('div', { class: 'acts' });
  if (secret) {
    const eye = iconBtn('eye', 'Afficher', () => { visible = !visible; render(); eye.replaceChildren(icon(visible ? 'eyeOff' : 'eye')); });
    acts.append(eye);
  }
  if (link && /^https?:|^[^:]+$/i.test(value)) {
    acts.append(iconBtn('external', 'Ouvrir', () => window.open(/^https?:/i.test(value) ? value : 'https://' + value, '_blank', 'noopener,noreferrer')));
  }
  const cp = iconBtn('copy', 'Copier', () => copy(value, copyLabel || label, cp));
  acts.append(cp);
  return h('div', { class: 'row' }, h('div', { class: 'body' }, h('div', { class: 'k' }, label), v), acts);
}

function totpRow(secret) {
  const code = h('div', { class: 'v totp-code' }, '··· ···');
  const ring = h('div', { class: 'ring' }, h('span'));
  let current = '';
  const tick = async () => {
    try {
      const t = await totp(secret);
      current = t.code;
      code.textContent = t.code.replace(/^(\d{3})(\d+)$/, '$1 $2');
      ring.firstChild.textContent = t.remaining;
      ring.style.setProperty('--p', t.remaining / t.period);
      ring.classList.toggle('low', t.remaining <= 5);
    } catch {
      code.textContent = 'Clé invalide';
      code.className = 'v';
    }
  };
  tick();
  totpTimer = setInterval(tick, 1000);
  const cp = iconBtn('copy', 'Copier', () => copy(current, 'Code 2FA', cp));
  return h('div', { class: 'row' }, h('div', { class: 'body' }, h('div', { class: 'k' }, 'Code 2FA'), code), ring, h('div', { class: 'acts' }, cp));
}

function historyCard(history) {
  if (!history?.length) return null;
  const rows = history.map((p) => fieldRow(p.date ? `Utilisé jusqu'au ${fmtDate(p.date)}` : 'Ancien mot de passe', p.password, { secret: true, copyLabel: 'Ancien mot de passe' }));
  const box = h('div', { hidden: true }, rows);
  const toggle = h('button', { class: 'btn ghost small history-toggle', onclick: () => { box.hidden = !box.hidden; toggle.lastChild.textContent = box.hidden ? `Historique des mots de passe (${history.length})` : 'Masquer l\'historique'; } },
    icon('clock'), h('span', {}, `Historique des mots de passe (${history.length})`));
  return h('div', {}, toggle, h('div', { class: 'card' }, box));
}

const card = (...rows) => {
  const r = rows.flat().filter(Boolean);
  return r.length ? h('div', { class: 'card' }, r) : null;
};

// refresh : redessiner même si l'entrée affichée est déjà celle-ci (après modification ou sync)
function showDetail(id, push = true, refresh = false) {
  const it = vault.items.get(id);
  if (!it) return;
  const same = state.selected === id && $('#detail').firstChild;
  if (same && !refresh) {
    for (const li of $('#list').children) li.classList.toggle('active', li.dataset.id === id);
    return;
  }
  state.selected = id;
  for (const li of $('#list').children) li.classList.remove('active');
  $('#list').children[state.results.indexOf(it)]?.classList.add('active');
  clearInterval(totpTimer);

  const name = it.name || '(sans nom)';
  const host = hostOf(it.uris?.[0]);
  // fondu seulement quand on choisit une entrée (clic), jamais pendant la frappe ou au clavier
  $('#detail').replaceChildren(h('div', { class: push && !refresh ? 'detail-inner enter' : 'detail-inner' },
    h('div', { class: 'hero' },
      iconBtn('back', 'Retour', () => history.state?.detail ? history.back() : closeDetail(), 'btn ghost round back'),
      avatar(name, it.icon, it),
      h('div', {},
        h('h2', {}, name),
        h('div', { class: 'sub' }, it.folder ? [icon('folder'), it.folder] : host ? [icon('globe'), host] : '')),
      h('div', { class: 'hero-actions' },
        h('button', { class: 'btn ghost round', title: 'Supprimer', disabled: !vault.online, onclick: () => removeItem(it) }, icon('trash')),
        h('button', { class: 'btn ghost round', title: 'Partager', disabled: !vault.online, onclick: () => openSend([it._id]) }, icon('share')),
        h('button', { class: 'btn primary', disabled: !vault.online, onclick: () => openEditor(it) }, icon('edit'), h('span', { class: 'label' }, 'Modifier')))),
    card(fieldRow('Identifiant', it.username), fieldRow('Mot de passe', it.password, { secret: true }), it.totp && totpRow(it.totp)),
    card((it.uris || []).map((u, i) => fieldRow(i ? `Site ${i + 1}` : 'Site', u, { link: true, copyLabel: 'Adresse' }))),
    card((it.fields || []).map((f) => fieldRow(f.name || 'Champ', String(f.value ?? ''), { secret: f.hidden }))),
    card(fieldRow('Notes', it.notes, { notes: true })),
    historyCard(it.history),
    h('div', { class: 'foot' }, it.updated ? `Modifié le ${fmtDate(it.updated)}` : '')));
  $('#detail').hidden = false;
  $('#detail').scrollTop = 0;
  if (push && !isWide() && !history.state?.detail) history.pushState({ detail: true }, '');
}

function closeDetail() {
  clearInterval(totpTimer);
  state.selected = null;
  $('#detail').replaceChildren();
  $('#detail').hidden = true;
  for (const li of $('#list').children) li.classList.remove('active');
}

window.addEventListener('popstate', () => { if (!isWide()) closeDetail(); });

async function removeItem(it) {
  if (!confirm(`Supprimer « ${it.name || 'sans nom'} » ?`)) return;
  try {
    await vault.save([{ id: it._id, del: true }]);
    if (history.state?.detail) history.back();
    closeDetail();
    renderList();
    toast('Entrée supprimée');
  } catch (e) {
    toast(e.message, 3000, false);
    renderList();
  }
  renderStatus();
}

// ------------------------------------------------------------------ éditeur

const edit = $('#edit-form');
let editing = null;

function cfRow(f = { name: '', value: '', hidden: false }) {
  let hidden = !!f.hidden;
  const value = h('input', { type: 'text', placeholder: 'Valeur', value: String(f.value ?? ''), 'data-k': 'value', autocomplete: 'off' });
  const toggle = h('button', { type: 'button', class: `btn ghost${hidden ? ' on' : ''}`, title: 'Valeur masquée' }, icon('lock'));
  toggle.onclick = () => { hidden = !hidden; toggle.classList.toggle('on', hidden); };
  const r = h('div', { class: 'cf' },
    h('input', { type: 'text', placeholder: 'Nom', value: f.name, 'data-k': 'name' }), value, toggle,
    h('button', { type: 'button', class: 'btn ghost', title: 'Retirer', onclick: () => r.remove() }, icon('x')));
  r.read = () => ({ name: $('[data-k=name]', r).value.trim(), value: value.value, hidden });
  return r;
}

function updateStrength() {
  const bits = strength(edit.password.value);
  const bar = $('#strength-bar');
  bar.style.width = `${Math.min(100, bits)}%`;
  bar.style.background = bits < 40 ? 'var(--danger)' : bits < 70 ? '#f59e0b' : 'var(--ok)';
}

function setPwVisible(on) {
  edit.password.type = on ? 'text' : 'password';
  $('[data-act=reveal]', edit).replaceChildren(icon(on ? 'eyeOff' : 'eye'));
}

function openEditor(it = null) {
  editing = it;
  $('#edit-title').textContent = it ? 'Modifier' : 'Nouvelle entrée';
  edit.reset();
  const v = it || { name: $('#q').value.trim() };
  for (const k of ['name', 'username', 'password', 'totp', 'folder', 'notes']) edit[k].value = v[k] || '';
  edit.uris.value = (v.uris || []).join('\n');
  edit.fav.checked = !!v.fav;
  setPwVisible(false);
  edit['g-len'].value = prefs.gen.length;
  $('#g-len-out').value = prefs.gen.length;
  edit['g-upper'].checked = prefs.gen.upper;
  edit['g-digits'].checked = prefs.gen.digits;
  edit['g-symbols'].checked = prefs.gen.symbols;
  $('#edit-fields').replaceChildren(...(v.fields || []).map(cfRow));
  $('#folders').replaceChildren(...[...new Set(vault.list().map((x) => x.folder).filter(Boolean))].sort().map((f) => h('option', { value: f })));
  $('#edit-error').textContent = '';
  updateStrength();
  $('#dlg-edit').showModal();
  $('.sheet-body', edit).scrollTop = 0;
  if (isWide()) edit.name.focus();
}

function genPassword() {
  prefs.gen = { length: +edit['g-len'].value, upper: edit['g-upper'].checked, digits: edit['g-digits'].checked, symbols: edit['g-symbols'].checked };
  savePrefs();
  edit.password.value = generatePassword({ ...prefs.gen, lower: true });
  setPwVisible(true);
  updateStrength();
}

edit.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'reveal') setPwVisible(edit.password.type === 'password');
  else if (act === 'gen') genPassword();
  else if (act === 'add-field') $('#edit-fields').append(cfRow());
  else if (act === 'cancel') $('#dlg-edit').close();
});
edit.password.oninput = updateStrength;
edit['g-len'].oninput = () => { $('#g-len-out').value = edit['g-len'].value; if (edit.password.type === 'text') genPassword(); };
for (const k of ['g-upper', 'g-digits', 'g-symbols']) edit[k].onchange = () => { if (edit.password.type === 'text') genPassword(); };

edit.onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#edit-error');
  if (!edit.name.value.trim()) return (err.textContent = 'Le nom est obligatoire');
  const item = withHistory(editing, {
    ...(editing || { type: 'login' }),
    name: edit.name.value.trim(),
    username: edit.username.value.trim(),
    password: edit.password.value,
    uris: edit.uris.value.split('\n').map((s) => s.trim()).filter(Boolean),
    totp: edit.totp.value.trim(),
    folder: edit.folder.value.trim(),
    notes: edit.notes.value,
    fav: edit.fav.checked,
    fields: [...$('#edit-fields').children].map((r) => r.read()).filter((f) => f.name || f.value),
  });
  const btn = $('button[type=submit]', edit);
  btn.disabled = true;
  try {
    if (item.icon && iconHost(item) !== iconHost(editing || {})) delete item.icon; // site changé
    if (iconHost(item) !== iconHost(editing || {})) delete item.iconTry;
    const [id] = await vault.save([{ item }]);
    if (!item.icon && iconHost(item)) setTimeout(() => scheduleIcons({ ids: [id], limit: 1 }), 50);
    $('#dlg-edit').close();
    renderList();
    showDetail(id, !editing, true);
    toast('Enregistré');
  } catch (ex) {
    err.textContent = ex.status === 409 ? 'Modifiée sur un autre appareil entre-temps : données rechargées, recommencez.' : ex.message;
    renderList();
  } finally {
    btn.disabled = false;
    renderStatus();
  }
};

// ------------------------------------------------------------------ menu

$('#btn-new').onclick = () => openEditor();
$('#btn-menu').onclick = () => {
  $('#menu-user').textContent = vault.profile.user;
  $('#menu-count').textContent = `${plural(vault.items.size, 'entrée')} · ${vault.online ? 'en ligne' : 'hors ligne'}`;
  $('#menu-avatar').replaceChildren(initial(vault.profile.user));
  $('#menu-avatar').style.background = avatarColor(vault.profile.user);
  $('#lock-delay').value = String(prefs.lock);
  for (const b of $('#dlg-menu').querySelectorAll('[data-act=import],[data-act=password],[data-act=revoke],[data-act=icons],[data-act=backups],[data-act=sends]')) b.disabled = !vault.online;
  $('#dlg-menu').showModal();
};
$('#lock-delay').onchange = (e) => { prefs.lock = +e.target.value; savePrefs(); };

$('#dlg-menu').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const close = () => $('#dlg-menu').close();
  switch (act) {
    case 'close': return close();
    case 'apps': close(); return openApps();
    case 'icons': close(); return fetchAllIcons();
    case 'backups': close(); return openBackups();
    case 'sends': close(); return openSends();
    case 'noicons': close(); return openNoIcons();
    case 'sync': close(); return doSync(true);
    case 'lock': close(); return lock();
    case 'import': return $('#import-file').click();
    case 'export': close(); return exportJson();
    case 'password':
      close();
      $('#pass-form').reset();
      $('#pass-error').textContent = '';
      return $('#dlg-pass').showModal();
    case 'revoke':
      if (!confirm('Déconnecter tous les autres appareils ? Ils devront se reconnecter.')) return;
      try {
        vault.api.token = (await vault.api.revoke()).token;
        saveSession();
        toast('Autres appareils déconnectés');
      } catch (ex) { toast(ex.message, 2500, false); }
      return close();
    case 'forget':
      if (!confirm('Effacer les données locales de cet appareil ? (rien n\'est supprimé sur le serveur)')) return;
      close();
      vault.lock();
      clearSession();
      await vault.forget();
      return showAuth('login');
  }
});

// Clic à côté : ferme le menu et les fenêtres d'information, jamais un formulaire (saisie perdue),
// et seulement si le clic commence ET finit sur le fond (une sélection de texte qui déborde ne ferme rien).
for (const d of document.querySelectorAll('dialog')) {
  let downOnBackdrop = false;
  d.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === d; });
  d.addEventListener('click', (e) => {
    if (e.target === d && downOnBackdrop && !d.querySelector('form')) d.close();
  });
}

$('#import-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('#dlg-menu').close();
  let items;
  try {
    items = parseBitwarden(await file.text());
  } catch (ex) {
    return toast(ex.message, 4000, false);
  }
  const key = (it) => [it.name, it.username, it.password, it.uris?.[0] || ''].join('\u0000');
  const existing = new Set(vault.list().map(key));
  const fresh = items.filter((it) => !existing.has(key(it)));
  if (!fresh.length) return toast('Rien de nouveau à importer', 2000, false);
  if (!confirm(`Importer ${plural(fresh.length, 'entrée')} ? (${plural(items.length - fresh.length, 'doublon')} ignoré(s))`)) return;
  try {
    for (let i = 0; i < fresh.length; i += 500) {
      toast(`Import… ${i}/${fresh.length}`, 60000, false);
      await vault.save(fresh.slice(i, i + 500).map((item) => ({ item })));
    }
    toast(`${plural(fresh.length, 'entrée')} importée(s). Supprimez le fichier d'export !`, 5000);
    setTimeout(() => scheduleIcons({ limit: 60 }), 6000);
  } catch (ex) {
    toast('Import interrompu : ' + ex.message, 5000, false);
  }
  renderList();
  renderStatus();
};

// ------------------------------------------------------------------ sauvegardes : comparaison et restauration

const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
let bkFilter = 'all';
let bkSnap = null;

async function openBackups() {
  if (!vault.api.token) return toast('Hors ligne : sauvegardes indisponibles', 2500, false);
  const sel = $('#bk-date');
  $('#bk-summary').replaceChildren();
  $('#bk-list').replaceChildren(h('div', { class: 'bk-empty' }, 'Chargement…'));
  $('#dlg-backups').showModal();
  let list;
  try {
    list = await vault.listBackups();
  } catch (e) {
    return $('#bk-list').replaceChildren(h('div', { class: 'bk-empty' }, e.message));
  }
  if (!list.length) {
    sel.replaceChildren();
    return $('#bk-list').replaceChildren(h('div', { class: 'bk-empty' }, 'Aucune sauvegarde pour l\'instant : le serveur en crée une le premier jour où le coffre est modifié.'));
  }
  sel.replaceChildren(...list.map((b) => h('option', { value: b.date }, `${fmtDay(b.date)} — ${plural(b.count, 'entrée')}`)));
  sel.onchange = () => loadBackup(sel.value);
  bkFilter = 'all';
  await loadBackup(list[0].date);
}

async function loadBackup(date) {
  $('#bk-list').replaceChildren(h('div', { class: 'bk-empty' }, 'Déchiffrement…'));
  try {
    bkSnap = { date, items: await vault.loadBackup(date) };
  } catch (e) {
    return $('#bk-list').replaceChildren(h('div', { class: 'bk-empty' }, e.message));
  }
  renderBackupDiff();
}

function renderBackupDiff() {
  const d = diffVaults(bkSnap.items, vault.items);
  const counts = { all: d.added.length + d.changed.length + d.removed.length, added: d.added.length, changed: d.changed.length, removed: d.removed.length };
  const labels = { all: 'Tout', added: 'Ajoutées depuis', changed: 'Modifiées', removed: 'Supprimées depuis' };
  $('#bk-summary').replaceChildren(...Object.keys(labels).map((k) => h('button', {
    type: 'button', class: 'bk-chip' + (bkFilter === k ? ' on' : ''), onclick: () => { bkFilter = k; renderBackupDiff(); },
  }, labels[k], h('b', {}, counts[k]))));
  const cards = [];
  if (bkFilter === 'all' || bkFilter === 'changed') for (const c of d.changed) cards.push(bkCard('changed', c.after, c));
  if (bkFilter === 'all' || bkFilter === 'removed') for (const it of d.removed) cards.push(bkCard('removed', it));
  if (bkFilter === 'all' || bkFilter === 'added') for (const it of d.added) cards.push(bkCard('added', it));
  $('#bk-list').replaceChildren(...(cards.length ? cards : [h('div', { class: 'bk-empty' }, counts.all ? 'Rien dans cette catégorie.' : 'Aucune différence entre cette sauvegarde et l\'état actuel.')]));
}

function bkValue(cls, value, secret) {
  let shown = !secret;
  const span = h('span');
  const render = () => { span.textContent = shown ? (value || '—') : '•'.repeat(Math.min(value.length, 14)); };
  render();
  const eye = secret && value && h('button', { type: 'button', title: 'Afficher', onclick: () => { shown = !shown; render(); } }, icon('eye'));
  return h('div', { class: cls }, span, eye);
}

function bkCard(kind, it, change) {
  const badge = { added: 'Ajoutée', changed: 'Modifiée', removed: 'Supprimée' }[kind];
  const action = kind === 'changed'
    ? h('button', { class: 'btn small', onclick: () => restoreVersion(change) }, icon('history'), 'Restaurer cette version')
    : kind === 'removed' ? h('button', { class: 'btn small', onclick: () => restoreRemoved(it) }, icon('history'), 'Restaurer') : null;
  const rows = [];
  if (kind === 'changed') {
    for (const f of change.fields) rows.push(h('div', { class: 'k' }, f.label), h('div', { class: 'bk-vals' }, bkValue('bk-old', f.before, f.secret), bkValue('bk-new', f.after, f.secret)));
  } else {
    for (const [key, label, secret] of DIFF_FIELDS.filter(([k]) => ['username', 'password', 'uris', 'folder'].includes(k))) {
      const v = key === 'uris' ? (it.uris || []).join('\n') : String(it[key] || '');
      if (v) rows.push(h('div', { class: 'k' }, label), h('div', { class: 'bk-vals' }, bkValue('bk-val', v, !!secret)));
    }
  }
  const name = it.name || '(sans nom)';
  return h('div', { class: 'bk-card' },
    h('div', { class: 'bk-head' }, avatar(name, it.icon, it), h('div', { class: 't' }, h('b', {}, name), h('small', {}, it.username || hostOf(it.uris?.[0]) || '')),
      h('span', { class: `bk-badge ${kind}` }, badge), action),
    rows.length ? h('div', { class: 'bk-diff' }, rows) : null);
}

// Remet les champs de la sauvegarde sur l'entrée actuelle (l'ancien mot de passe va dans l'historique).
async function restoreVersion(change) {
  if (!confirm(`Restaurer « ${change.before.name || 'sans nom'} » telle qu'au ${fmtDay(bkSnap.date)} ?`)) return;
  const restored = { ...change.after };
  for (const [key] of DIFF_FIELDS) {
    if (change.before[key] === undefined) delete restored[key];
    else restored[key] = change.before[key];
  }
  if (iconHost(restored) !== iconHost(change.after)) { delete restored.icon; delete restored.iconTry; }
  try {
    await vault.save([{ item: withHistory(change.after, restored) }]);
    toast('Version restaurée');
  } catch (e) {
    toast(e.message, 3000, false);
  }
  renderList();
  renderBackupDiff();
}

// Recrée une entrée supprimée depuis la sauvegarde, avec son identifiant d'origine.
async function restoreRemoved(it) {
  try {
    await vault.save([{ item: it }], { touch: false });
    toast('Entrée restaurée');
  } catch (e) {
    toast(e.message, 3000, false);
  }
  renderList();
  renderBackupDiff();
}

$('#dlg-backups').addEventListener('click', (e) => { if (e.target.closest('[data-act=close]')) $('#dlg-backups').close(); });

// ------------------------------------------------------------------ Send : partages chiffrés

const sendForm = $('#send-form');
let sendIds = [];
const appBase = () => location.origin + location.pathname.replace(/[^/]*$/, '');
const sendLink = (id, k) => `${appBase()}index.php?s=${id}#${k}`;
const fmtDateTime = (s) => new Date(s * 1000).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

function miniAvatar(it) {
  const a = avatar(it.name || '?', it.icon, it);
  return a;
}

function renderSendItems() {
  $('#send-items').replaceChildren(...sendIds.map((id) => {
    const it = vault.items.get(id);
    return h('span', { class: 'send-chip' }, miniAvatar(it), h('span', {}, it.name || '(sans nom)'),
      h('button', { type: 'button', title: 'Retirer', onclick: () => { sendIds = sendIds.filter((x) => x !== id); renderSendItems(); } }, icon('x')));
  }));
}

function openSend(ids) {
  sendIds = [...ids];
  sendForm.reset();
  $('.error', sendForm).textContent = '';
  $('#send-add').value = '';
  $('#send-add-results').hidden = true;
  renderSendItems();
  sendForm.hidden = false;
  $('#send-done').hidden = true;
  $('#dlg-send').showModal();
}

$('#send-add').oninput = (e) => {
  const q = e.target.value.trim();
  const box = $('#send-add-results');
  const found = q ? search(vault.list(), q).filter((it) => !sendIds.includes(it._id)).slice(0, 8) : [];
  box.hidden = !found.length;
  box.replaceChildren(...found.map((it) => h('button', { type: 'button', onclick: () => {
    sendIds.push(it._id);
    renderSendItems();
    e.target.value = '';
    box.hidden = true;
    e.target.focus();
  } }, miniAvatar(it), h('span', {}, it.name || '(sans nom)'), h('small', { class: 'muted' }, it.username || ''))));
};

sendForm.addEventListener('click', (e) => { if (e.target.closest('[data-act=cancel]')) $('#dlg-send').close(); });
$('#send-done').addEventListener('click', (e) => { if (e.target.closest('[data-act=close]')) $('#dlg-send').close(); });

sendForm.onsubmit = async (e) => {
  e.preventDefault();
  const f = sendForm;
  const err = $('.error', f);
  if (!sendIds.length) return (err.textContent = 'Choisissez au moins une entrée');
  const keep = (k) => f['f-' + k].checked;
  const items = sendIds.map((id) => {
    const it = vault.items.get(id);
    const o = { name: it.name || '' };
    if (keep('username') && it.username) o.username = it.username;
    if (keep('password') && it.password) o.password = it.password;
    if (keep('uris') && it.uris?.length) o.uris = it.uris;
    if (keep('totp') && it.totp) o.totp = it.totp;
    if (keep('notes') && it.notes) o.notes = it.notes;
    if (keep('fields') && it.fields?.length) o.fields = it.fields;
    if (it.icon) o.icon = it.icon;
    return o;
  });
  const ttl = +f.ttl.value;
  const views = +f.views.value;
  const pin = f.pin.checked ? sendPin() : '';
  const title = items.map((i) => i.name).join(', ');
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  try {
    const r = await vault.createSend({ v: 1, from: vault.profile.user, message: f.message.value.trim(), items, created: Date.now() },
      { title, expiresIn: ttl, maxViews: views, pin });
    showSendDone({ ...r, title, count: items.length, expires: Math.floor(Date.now() / 1000) + ttl, max_views: views, message: f.message.value.trim() });
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
};

function sendTexts(s) {
  const link = sendLink(s.id, s.k);
  const what = s.count > 1 ? `${s.count} accès` : `l'accès « ${s.title} »`;
  const limits = `valable jusqu'au ${fmtDateTime(s.expires)}${s.max_views ? `, ${s.max_views} consultation${s.max_views > 1 ? 's' : ''} au plus` : ''}`;
  const text = `${s.message ? s.message + '\n\n' : ''}${vault.profile.user} vous partage ${what} de façon sécurisée :\n${link}\n\n(Lien ${limits}.${s.pin ? ' Le code d\'ouverture vous est transmis séparément.' : ''})`;
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#0f172a">`
    + (s.message ? `<p style="white-space:pre-wrap">${esc(s.message)}</p>` : '')
    + `<p><b>${esc(vault.profile.user)}</b> vous partage ${esc(what)} de façon sécurisée.</p>`
    + `<p style="margin:28px 0"><a href="${esc(link)}" style="background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;padding:13px 22px;border-radius:10px;text-decoration:none;font-weight:600">Ouvrir le partage</a></p>`
    + `<p style="color:#64748b;font-size:13px">Lien ${esc(limits)}.${s.pin ? ' Le code d\'ouverture vous est transmis séparément.' : ''}<br>Chiffré de bout en bout avec BioPass.</p></div>`;
  return { link, text, html, subject: `${vault.profile.user} vous partage ${s.count > 1 ? 'des accès' : 'un accès'}` };
}

async function showSendDone(s) {
  const { link, text, html, subject } = sendTexts(s);
  let smtp = false;
  try { smtp = (await vault.api.call('send_list', null)).smtp; } catch {}
  const cpLink = iconBtn('copy', 'Copier le lien', () => copy(link, 'Lien', cpLink), 'btn ghost round');
  const mailTo = h('input', { type: 'email', placeholder: 'adresse@exemple.fr', autocomplete: 'email' });
  const mailBtn = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    if (!mailTo.value.trim()) return mailTo.focus();
    mailBtn.disabled = true;
    try {
      await vault.api.call('send_mail', { to: mailTo.value.trim(), subject, text, html });
      toast('E-mail envoyé');
      mailTo.value = '';
    } catch (ex) {
      toast(ex.message, 3500, false);
    } finally {
      mailBtn.disabled = false;
    }
  } }, icon('send'), 'Envoyer');
  const body = [
    h('p', { class: 'hint' }, `« ${s.title} » — lien ${s.max_views ? `utilisable ${s.max_views} fois, ` : ''}valable jusqu'au ${fmtDateTime(s.expires)}.`),
    h('div', { class: 'copy-box' }, h('code', {}, link), cpLink),
    h('div', { class: 'send-share' },
      h('a', { class: 'btn', href: 'https://wa.me/?text=' + encodeURIComponent(text), target: '_blank', rel: 'noopener' }, icon('chat'), 'WhatsApp'),
      smtp ? null : h('a', { class: 'btn', href: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}` }, icon('mail'), 'E-mail'),
      h('button', { type: 'button', class: 'btn', onclick: () => copy(text, 'Message') }, icon('copy'), 'Copier le message')),
  ];
  if (smtp) body.push(h('div', { class: 'group-title' }, 'Envoyer par e-mail'), h('div', { class: 'mail-form' }, mailTo, mailBtn));
  if (s.pin) {
    const cpPin = iconBtn('copy', 'Copier le code', () => copy(s.pin, 'Code', cpPin), 'btn ghost round');
    body.push(h('div', { class: 'pin-box' }, icon('key'), h('code', {}, s.pin), cpPin,
      h('a', { class: 'btn small', href: 'https://wa.me/?text=' + encodeURIComponent(`Code d'ouverture du partage BioPass : ${s.pin}`), target: '_blank', rel: 'noopener' }, icon('chat'), 'WhatsApp')),
    h('p', { class: 'hint' }, 'Transmettez ce code par un autre moyen que le lien (SMS, WhatsApp, de vive voix…). 5 codes faux détruisent le partage.'));
  }
  $('#send-done-body').replaceChildren(...body.filter(Boolean));
  sendForm.hidden = true;
  $('#send-done').hidden = false;
}

async function openSends() {
  const list = $('#sends-list');
  list.replaceChildren(h('div', { class: 'bk-empty' }, 'Chargement…'));
  $('#dlg-sends').showModal();
  let r;
  try {
    r = await vault.listSends();
  } catch (e) {
    return list.replaceChildren(h('div', { class: 'bk-empty' }, e.message));
  }
  if (!r.sends.length) return list.replaceChildren(h('div', { class: 'bk-empty' }, 'Aucun partage. Ouvrez une entrée et cliquez sur l\'icône de partage.'));
  list.replaceChildren(...r.sends.map((s) => {
    const views = s.max_views ? `${s.views}/${s.max_views} consultation${s.max_views > 1 ? 's' : ''}` : `${s.views} consultation${s.views > 1 ? 's' : ''}`;
    const last = s.opened?.length ? ` · dernière le ${fmtDateTime(s.opened[s.opened.length - 1])}` : '';
    const cp = s.k && s.alive ? iconBtn('link', 'Copier le lien', () => copy(sendLink(s.id, s.k), 'Lien', cp), 'btn ghost round') : null;
    const cpPin = s.pin && s.alive && typeof s.pin === 'string' ? iconBtn('key', 'Copier le code', () => copy(s.pin, 'Code', cpPin), 'btn ghost round') : null;
    return h('div', { class: 'send-row' },
      h('div', { class: 't' }, h('b', {}, s.title), h('small', {}, `${views}${last} · expire le ${fmtDateTime(s.expires)}`)),
      h('span', { class: 'state ' + (s.alive ? 'on' : 'off') }, s.alive ? 'Actif' : 'Terminé'),
      cp, cpPin,
      iconBtn('trash', s.alive ? 'Révoquer' : 'Supprimer', async () => {
        if (s.alive && !confirm(`Révoquer le partage « ${s.title} » ? Le lien ne fonctionnera plus.`)) return;
        try { await vault.deleteSend(s.id); openSends(); } catch (ex) { toast(ex.message, 3000, false); }
      }, 'btn ghost round'));
  }));
}

// ------------------------------------------------------------------ entrées sans icône de site

const NOICON_GROUPS = [
  ['site', 'Site sans icône trouvée', 'Le site ne publie pas d\'icône lisible ou refuse les robots. Mettez l\'adresse principale du site (ex. https://www.exemple.fr) plutôt qu\'une page profonde, puis « Récupérer les icônes ». Pour un domaine à vous, réglez « icon_pages » dans config.php.'],
  ['pending', 'Pas encore récupérée', 'Elle le sera en tâche de fond, ou tout de suite avec « Récupérer les icônes des sites ».'],
  ['network', 'Adresse IP ou réseau local', 'Normal : un équipement local (box, NAS, imprimante) n\'a pas d\'icône accessible depuis le serveur. Icône « réseau » dédiée.'],
  ['terminal', 'Serveur / SSH', 'Icône « terminal » dédiée. Pour avoir le logo de l\'hébergeur, ajoutez son site web en deuxième adresse.'],
  ['app', 'Application Android', 'Seule une adresse androidapp:// est connue : ajoutez le site web du service pour avoir son logo.'],
  ['wifi', 'Wi-Fi', 'Icône « Wi-Fi » dédiée.'],
  ['card', 'Carte bancaire', 'Icône « carte » dédiée.'],
  ['key', 'Clé, jeton, licence', 'Icône « clé » dédiée. Ajoutez le site du service pour avoir son logo.'],
  ['note', 'Note ou entrée sans site', 'Icône « note » dédiée. Ajoutez une adresse de site à l\'entrée si elle correspond à un service en ligne.'],
  ['none', 'Autres', 'Initiale colorée. Ajoutez l\'adresse du site pour avoir son logo.'],
];

function noIconGroup(it) {
  if (iconHost(it)) return it.iconTry ? 'site' : 'pending';
  return entryKind(it) || 'none';
}

function openNoIcons() {
  const missing = vault.list().filter((it) => !it.icon);
  const byGroup = new Map();
  for (const it of missing) {
    const g = noIconGroup(it);
    byGroup.set(g, [...(byGroup.get(g) || []), it]);
  }
  const parts = [h('p', { class: 'hint' }, `${plural(missing.length, 'entrée')} sans icône de site sur ${vault.items.size}.`)];
  for (const [key, title, advice] of NOICON_GROUPS) {
    const list = (byGroup.get(key) || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!list.length) continue;
    parts.push(h('div', { class: 'group-title' }, `${title} (${list.length})`), h('p', { class: 'hint' }, advice),
      h('div', { class: 'card' }, list.map((it) => h('div', { class: 'send-row noicon', onclick: () => { $('#dlg-noicons').close(); showDetail(it._id); } },
        avatar(it.name || '?', null, it), h('div', { class: 't' }, h('b', {}, it.name || '(sans nom)'), h('small', {}, (it.uris || []).join(' · ') || it.username || ''))))));
  }
  if (!missing.length) parts.push(h('div', { class: 'bk-empty' }, 'Toutes les entrées ont une icône. 🎉'));
  $('#noicons-list').replaceChildren(...parts);
  $('#dlg-noicons').showModal();
}

$('#dlg-noicons').addEventListener('click', (e) => { if (e.target.closest('[data-act=close]')) $('#dlg-noicons').close(); });

$('#dlg-sends').addEventListener('click', (e) => { if (e.target.closest('[data-act=close]')) $('#dlg-sends').close(); });

// ------------------------------------------------------------------ applications à télécharger

function serverAddress() {
  const key = $('meta[name=bp-key]')?.content || new URLSearchParams(location.search).get('k') || '';
  const base = location.origin + location.pathname.replace(/[^/]*$/, ''); // sans « index.php »
  return base + (key ? '?k=' + encodeURIComponent(key) : '');
}

async function openApps() {
  $('#apps-server').textContent = serverAddress();
  let v = {};
  try {
    const r = await fetch('index.php?f=downloads/versions.json', { cache: 'no-store' });
    if (r.ok) v = await r.json();
  } catch {}
  const size = (n) => n ? `${(n / 1024 / (n > 1048576 ? 1024 : 1)).toFixed(n > 1048576 ? 1 : 0)} ${n > 1048576 ? 'Mo' : 'Ko'}` : '';
  const date = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '';
  const cardFor = (href, ico, bg, title, info, steps) => {
    const ic = h('div', { class: 'app-ico' }, icon(ico));
    ic.style.background = bg;
    return [
      h('a', { class: 'app-card', href, download: '' }, ic,
        h('div', {}, h('b', {}, title), h('small', {}, info ? [`Version ${info.version}`, size(info.size), date(info.date)].filter(Boolean).join(' · ') : 'Non publiée sur ce serveur')),
        h('span', { class: 'dl' }, icon('download'))),
      h('ol', { class: 'steps' }, steps.map((s) => h('li', {}, s))),
    ];
  };
  const android = cardFor('index.php?f=downloads/biopass.apk', 'android', 'linear-gradient(135deg,#22c55e,#15803d)', 'App Android', v.apk, [
    'Téléchargez l\'APK et ouvrez-la (autorisez l\'installation depuis le navigateur si Android le demande).',
    'Saisissez l\'adresse ci-dessus, votre identifiant et votre mot de passe maître.',
    'Paramètres Android → Mots de passe et comptes → Service de saisie automatique → BioPass.',
  ]);
  const e = v.extension || {};
  const onAndroid = /android/i.test(navigator.userAgent);
  const onLinux = !onAndroid && /linux/i.test(navigator.userAgent);
  const extInstall = [];
  if (e.store_url) {
    extInstall.push(h('a', { class: 'btn primary block-link', href: e.store_url, target: '_blank', rel: 'noopener' }, icon('puzzle'), 'Installer depuis le Chrome Web Store'));
  }
  if (onLinux && e.id && e.update_url) {
    // Script servi par ce serveur : pose la politique du navigateur (installation + mises à jour automatiques)
    const key = $('meta[name=bp-key]')?.content || '';
    const script = location.origin + location.pathname.replace(/[^/]*$/, '') + 'index.php?f=downloads/install-brave.sh' + (key ? '&k=' + encodeURIComponent(key) : '');
    const cmd = `curl -fsSL '${script}' | sh`;
    const cp = iconBtn('copy', 'Copier la commande', () => copy(cmd, 'Commande', cp), 'btn ghost round');
    extInstall.push(h('div', { class: 'group-title' }, 'Installation automatique (Linux : Brave, Chrome, Chromium)'),
      h('div', { class: 'copy-box' }, h('code', {}, cmd), cp),
      h('p', { class: 'hint' }, 'Collez la commande dans un terminal (mot de passe sudo demandé), puis redémarrez le navigateur : l\'extension s\'installe et se met à jour toute seule. Supprimez alors l\'éventuelle version installée à la main. ',
        h('a', { href: 'index.php?f=downloads/install-brave.sh' }, 'Voir le script')));
  }
  const ext = cardFor('index.php?f=downloads/biopass-extension.zip', 'puzzle', 'linear-gradient(135deg,#f97316,#c2410c)', 'Extension Brave / Chrome', v.extension, [
    'Téléchargez le .zip et décompressez-le dans un dossier que vous garderez.',
    h('span', {}, 'Ouvrez ', h('code', {}, 'brave://extensions'), ', activez le « Mode développeur ».'),
    'Cliquez « Charger l\'extension non empaquetée » et choisissez le dossier biopass-extension.',
    'Épinglez l\'icône BioPass, puis saisissez l\'adresse ci-dessus.',
  ]);
  if (extInstall.length) extInstall.push(h('div', { class: 'group-title' }, 'Installation manuelle, si besoin'));
  ext.splice(1, 0, ...extInstall);
  $('#apps-list').replaceChildren(...(onAndroid ? [android, ext] : [ext, android]).flat());
  $('#dlg-apps').showModal();
}

$('#dlg-apps').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') $('#dlg-apps').close();
  if (act === 'copy-server') copy(serverAddress(), 'Adresse');
});

function exportJson() {
  if (!confirm('L\'export contient tous vos mots de passe EN CLAIR. Continuer ?')) return;
  const items = vault.list().map((it) => Object.fromEntries(Object.entries(it).filter(([k]) => !k.startsWith('_'))));
  const blob = new Blob([JSON.stringify({ app: 'biopass', exported: new Date().toISOString(), items }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `biopass-${vault.profile.user}-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#pass-form').addEventListener('click', (e) => { if (e.target.closest('[data-act=cancel]')) $('#dlg-pass').close(); });
$('#pass-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#pass-error');
  if (f.new.value.length < 5) return (err.textContent = 'Au moins 5 caractères');
  if (f.new.value !== f.new2.value) return (err.textContent = 'Les mots de passe ne correspondent pas');
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  err.textContent = '';
  try {
    await vault.changePassword(f.old.value, f.new.value);
    saveSession();
    $('#dlg-pass').close();
    toast('Mot de passe maître changé');
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    f.reset();
  }
};

// ------------------------------------------------------------------ clavier, recherche

// La recherche ne fait que filtrer et surligner : la fiche de droite ne change que sur un choix
// explicite (clic, Entrée).
$('#q').oninput = () => {
  state.cursor = 0;
  renderList();
};
$('#q').onkeydown = (e) => {
  const it = state.results[state.cursor];
  if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Escape') { e.target.value = ''; e.target.oninput(); }
  else if (e.key === 'Enter' && it) {
    e.preventDefault();
    showDetail(it._id);
    if (e.shiftKey) copy(it.username, 'Identifiant');
    else copy(it.password, 'Mot de passe');
  }
};

document.addEventListener('keydown', (e) => {
  if ($('#app').hidden || document.querySelector('dialog[open]')) return;
  if (e.key === '/' && !typing(document.activeElement)) { e.preventDefault(); $('#q').focus(); }
  else if (e.key === 'Escape' && !isWide() && state.selected) history.state?.detail ? history.back() : closeDetail();
});

// ------------------------------------------------------------------ verrouillage auto, sync périodique

for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(ev, () => { state.lastActive = Date.now(); }, { passive: true, capture: true });
}

function idleCheck() {
  if (!vault.unlocked) return;
  if (Date.now() - state.lastActive > prefs.lock * 60000) return lock();
  saveSession();
  if (document.visibilityState === 'visible' && Date.now() - state.lastSync > 5 * 60000) {
    state.lastSync = Date.now();
    doSync().then(() => scheduleIcons());
  }
}
setInterval(idleCheck, 10000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') idleCheck(); });
window.addEventListener('online', () => doSync());

// ------------------------------------------------------------------ démarrage

hydrateIcons();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('index.php?f=sw.js', { scope: './' }).catch(() => {});
await vault.load();
if (!(await resumeSession())) showAuth(vault.profile ? 'unlock' : 'login');
