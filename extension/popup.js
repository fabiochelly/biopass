// BioPass — popup de l'extension.
import { search, prepareSearch, hostOf, matchesUrl, generatePassword, normServer, parseServer, webUrl, withHistory, iconHost, entryKind } from './lib/core.js';
import { icon, hydrateIcons, avatarColor, initial, KIND_COLORS, KIND_ICONS } from './lib/icons.js';

const $ = (sel, el = document) => el.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

async function bg(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (r?.error) throw Object.assign(new Error(r.error), { status: r.status });
  return r?.data;
}

const isWindow = new URLSearchParams(location.search).has('window');
let st = null;
let tab = null;
let items = [];
let flat = [];
let sel = 0;
const pageUrl = () => tab?.url || '';
const isWeb = () => /^https?:/.test(pageUrl());

// ------------------------------------------------------------------ utilitaires

function toast(msg, ok = true) {
  const t = $('#toast');
  t.replaceChildren(ok ? icon('check') : '', msg);
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1600);
}

// Liste allégée (sans mots de passe ni icônes) : le mot de passe est demandé au moment de le copier.
// Réponse « popup » du service worker : liste allégée, avec les icônes des premières lignes déjà posées.
const listOf = (r) => {
  for (const it of r.list || []) if (it._id in (r.icons || {})) it.icon = r.icons[it._id];
  return r.list || [];
};
const fetchList = async () => listOf(await bg('popup', { first: FIRST }));
const copySecret = async (it, btn, field = 'password') =>
  copy(await bg('secret', { id: it._id, field }), field === 'password' ? 'Mot de passe' : 'Identifiant', btn);

async function copy(text, label, btn) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  bg('clipboardCopied').catch(() => {}); // le service worker l'effacera dans 30 s
  toast(`${label} copié`);
  if (btn) {
    const prev = btn.innerHTML;
    btn.classList.add('done');
    btn.replaceChildren(icon('check'));
    setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = prev; }, 1100);
  }
}

function avatar(name, siteIcon, it = null) {
  if (siteIcon) return h('div', { class: 'avatar site' + (it?.iconTone ? ' ' + it.iconTone : '') }, h('img', { src: siteIcon, alt: '', decoding: 'async' }));
  const kind = it && ('kind' in it ? it.kind : entryKind(it)); // calculé par le service worker
  if (kind) {
    const k = h('div', { class: 'avatar kind' }, icon(KIND_ICONS[kind]));
    k.style.background = KIND_COLORS[kind];
    return k;
  }
  const a = h('div', { class: 'avatar' }, initial(name));
  a.style.background = avatarColor(name);
  return a;
}

function show(view) {
  for (const v of ['setup', 'locked', 'main']) $(`#v-${v}`).hidden = v !== view;
  for (const p of document.querySelectorAll('.panel')) p.hidden = true;
}

function busy(form, on) {
  const b = $('button[type=submit]', form);
  b.disabled = on;
  b.classList.toggle('busy', on);
}

// ------------------------------------------------------------------ routage

async function route(init = null) {
  init ??= await bg('popup', { first: FIRST });
  st = init.status;
  if (!st.configured) {
    show('setup');
    $('#setup-form').server.focus();
  } else if (!st.unlocked) {
    show('locked');
    $('#locked-user').textContent = `Coffre de ${st.user}`;
    $('#unlock-form').password.focus();
  } else {
    loadMain(listOf(init));
  }
}

$('#setup-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('.error', f);
  err.textContent = '';
  let server = '';
  try { server = normServer(f.server.value); } catch {}
  if (!server || !f.user.value.trim() || !f.password.value) return (err.textContent = 'Tous les champs sont requis');
  busy(f, true);
  try {
    await bg('login', { server, user: f.user.value, password: f.password.value });
    f.password.value = '';
    await route();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    busy(f, false);
  }
};

$('#unlock-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('.error', f);
  err.textContent = '';
  if (!f.password.value) return;
  busy(f, true);
  try {
    await bg('unlock', { password: f.password.value });
    f.password.value = '';
    await route();
  } catch (ex) {
    err.textContent = ex.message;
    f.password.select();
  } finally {
    busy(f, false);
  }
};

$('#btn-switch').onclick = async () => {
  if (!confirm('Se déconnecter de ce compte sur ce navigateur ?')) return;
  await bg('forget');
  await route();
};

// ------------------------------------------------------------------ liste

function loadMain(list) {
  show('main');
  items = list;
  renderStatus();
  render();
  // recherche préparée par petits paquets quand le navigateur est libre : première frappe immédiate
  let i = 0;
  const prep = (deadline) => {
    while (i < list.length && items === list && (!deadline || deadline.timeRemaining() > 1)) prepareSearch(list[i++]);
    if (i < list.length && items === list) idle(prep);
  };
  idle(prep);
  $('#q').focus();
  bg('sync').then(async (changed) => {
    if (changed) {
      items = await fetchList();
      render();
    }
    st = await bg('status');
    renderStatus();
  }).catch(() => {});
}

function renderStatus() {
  const s = $('#status');
  s.classList.toggle('offline', !st.online);
  s.textContent = st.online ? st.user : `${st.user} · hors ligne`;
  $('#btn-add').disabled = !st.online;
}

// Rendu rapide : lignes mémorisées (une par entrée et par section) et réutilisées d'une frappe à
// l'autre ; les lignes visibles tout de suite, le reste quand le navigateur est libre (annulé à la
// frappe suivante).
const FIRST = 12; // lignes visibles dans le popup (580 px)
let renderToken = 0;
const rowCaches = { site: new WeakMap(), all: new WeakMap() };
const idle = (f) => (window.requestIdleCallback ? requestIdleCallback(f, { timeout: 200 }) : setTimeout(f, 16));

function placeRow(it, idx, kind) {
  let el = rowCaches[kind].get(it);
  if (!el) rowCaches[kind].set(it, (el = row(it)));
  el.dataset.idx = idx;
  return el;
}

// Icônes des entrées (it.iconLazy) chargées avant d'afficher leurs lignes.
async function loadIcons(list) {
  const ids = list.filter((it) => it.iconLazy && it.icon === undefined).map((it) => it._id);
  if (!ids.length) return;
  const icons = await bg('icons', { ids }).catch(() => ({}));
  for (const it of list) if (it._id in icons) it.icon = icons[it._id];
}
const rowsOf = (nodes) => nodes.filter((n) => !(n instanceof Node)).map((n) => n.it);

function render() {
  const q = $('#q').value.trim();
  const box = $('#results');
  const nodes = [];
  flat = [];
  const section = (title, aside, list, kind) => {
    if (!list.length) return;
    nodes.push(h('div', { class: 'section' }, h('span', {}, title), h('span', {}, aside || '')));
    for (const it of list) {
      nodes.push({ it, idx: flat.length, kind });
      flat.push(it);
    }
  };
  if (!q && isWeb()) {
    const site = items.filter((it) => matchesUrl(it, pageUrl())).sort((a, b) => (b.fav - a.fav) || (a.name || '').localeCompare(b.name || ''));
    section('Sur ce site', hostOf(pageUrl()).replace(/^www\./, ''), site, 'site');
  }
  const all = search(items, q);
  section(q ? 'Résultats' : 'Toutes les entrées', String(all.length), all.slice(0, 300), 'all');
  if (!flat.length) {
    nodes.push(h('div', { class: 'empty' }, icon(q ? 'search' : 'shield'),
      h('b', {}, q ? 'Aucun résultat' : 'Coffre vide'), q ? `Rien pour « ${q} »` : 'Ajoutez des entrées depuis le coffre web.'));
  }
  const toEl = (n) => (n instanceof Node ? n : placeRow(n.it, n.idx, n.kind));
  const token = ++renderToken;
  sel = Math.min(sel, Math.max(0, flat.length - 1));
  let next = FIRST;
  const more = async (deadline) => {
    if (token !== renderToken || next >= nodes.length) return;
    const end = Math.min(nodes.length, next + 60);
    await loadIcons(rowsOf(nodes.slice(next, end)));
    if (token !== renderToken) return;
    const frag = document.createDocumentFragment();
    do frag.append(toEl(nodes[next])); while (++next < end && (!deadline || deadline.timeRemaining() > 2));
    box.append(frag);
    idle(more);
  };
  const paint = () => {
    if (token !== renderToken) return;
    box.replaceChildren(...nodes.slice(0, FIRST).map(toEl));
    performance.mark('bp:rows');
    highlight();
    idle(more);
  };
  const first = rowsOf(nodes.slice(0, FIRST));
  if (first.some((it) => it.iconLazy && it.icon === undefined)) loadIcons(first).then(paint);
  else paint();
}

function row(it) {
  const name = it.name || hostOf(it.uris?.[0]) || '(sans nom)';
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e.currentTarget); };
  const acts = h('div', { class: 'acts' },
    isWeb() && (it.username || it.hasPw) && h('button', { class: 'ib fill', title: 'Remplir', onclick: stop(() => fill(it)) }, icon('fill')),
    it.username && h('button', { class: 'ib', title: 'Copier l\'identifiant', onclick: stop((b) => copy(it.username, 'Identifiant', b)) }, icon('user')),
    it.hasPw && h('button', { class: 'ib', title: 'Copier le mot de passe', onclick: stop((b) => copySecret(it, b)) }, icon('key')),
    it.totp && h('button', { class: 'ib', title: 'Copier le code 2FA', onclick: stop(async (b) => copy(await bg('totp', { id: it._id }), 'Code 2FA', b)) }, icon('clock')),
    h('button', { class: 'ib', title: 'Modifier', onclick: stop(() => openEditor(it)) }, icon('edit')));
  return h('div', {
    class: 'item',
    onclick: () => (isWeb() ? fill(it) : copySecret(it)),
    onmouseenter: (e) => { sel = +e.currentTarget.dataset.idx; highlight(); },
  }, avatar(name, it.icon, it), h('div', { class: 'meta' },
    h('div', { class: 'n' }, name, it.fav && icon('star', 'fav')),
    h('div', { class: 'u' }, it.username || hostOf(it.uris?.[0]) || '')), acts);
}

function highlight() {
  for (const el of document.querySelectorAll('.item')) el.classList.toggle('sel', +el.dataset.idx === sel);
}

async function fill(it, force = false) {
  if (!isWeb()) return;
  if (!force && !matchesUrl(it, pageUrl())) {
    $('#mismatch').hidden = false;
    $('#btn-force').onclick = () => fill(it, true);
    return;
  }
  try {
    await bg('fill', { id: it._id, force, tabId: tab.id });
    if (it.totp) {
      await navigator.clipboard.writeText(await bg('totp', { id: it._id }));
      toast('Code 2FA copié');
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!isWindow) window.close();
    else toast('Rempli');
  } catch (e) {
    toast(e.message, false);
  }
}

$('#q').oninput = () => {
  sel = 0;
  $('#mismatch').hidden = true;
  render();
};

document.addEventListener('keydown', (e) => {
  if ($('#v-main').hidden || document.querySelector('.panel:not([hidden])')) {
    if (e.key === 'Escape' && document.querySelector('.panel:not([hidden])')) {
      e.preventDefault();
      closePanels();
    }
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sel = Math.max(0, Math.min(flat.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
    highlight();
    document.querySelector(`.item[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && flat[sel] && document.activeElement === $('#q')) {
    e.preventDefault();
    const it = flat[sel];
    if (e.shiftKey) copy(it.username, 'Identifiant');
    else if (e.ctrlKey || e.metaKey || !isWeb()) copySecret(it);
    else fill(it);
  }
});

// ------------------------------------------------------------------ panneaux

function openPanel(id) {
  $(`#${id}`).hidden = false;
}
function closePanels() {
  for (const p of document.querySelectorAll('.panel')) p.hidden = true;
  $('#q').focus();
}
for (const b of document.querySelectorAll('[data-close]')) b.onclick = closePanels;

const gen = { length: 20, upper: true, digits: true, symbols: true };
function strength(pw) {
  let pool = 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z\d]/.test(pw)) pool += 20;
  return pw.length * Math.log2(pool);
}
function regen() {
  Object.assign(gen, { length: +$('#gen-len').value, upper: $('#gen-upper').checked, digits: $('#gen-digits').checked, symbols: $('#gen-symbols').checked });
  $('#gen-len-out').value = gen.length;
  const pw = generatePassword({ ...gen, lower: true });
  $('#gen-pw').textContent = pw;
  const bits = strength(pw);
  const bar = $('#gen-strength');
  bar.style.width = `${Math.min(100, bits)}%`;
  bar.style.background = bits < 40 ? 'var(--danger)' : bits < 70 ? '#f59e0b' : 'var(--ok)';
}
$('#btn-gen').onclick = () => { regen(); openPanel('p-gen'); };
for (const id of ['gen-len', 'gen-upper', 'gen-digits', 'gen-symbols']) $(`#${id}`).oninput = regen;
$('#gen-again').onclick = regen;
$('#gen-copy').onclick = (e) => copy($('#gen-pw').textContent, 'Mot de passe');

// Création (sans argument : pré-remplie avec le site courant) ou modification d'une entrée.
let editing = null;
async function openEditor(summary = null) {
  const it = summary && await bg('item', { id: summary._id }); // entrée complète, demandée à l'ouverture
  editing = it;
  const f = $('#add-form');
  f.reset();
  $('.error', f).textContent = '';
  $('#edit-title').textContent = it ? 'Modifier' : 'Nouvel identifiant';
  $('#edit-delete').hidden = !it;
  if (it) {
    for (const k of ['name', 'username', 'password', 'totp', 'notes']) f[k].value = it[k] || '';
    f.uris.value = (it.uris || []).join('\n');
  } else {
    if (isWeb()) {
      const u = new URL(pageUrl());
      f.name.value = u.hostname.replace(/^www\./, '');
      f.uris.value = u.origin;
    }
    f.password.value = generatePassword({ ...gen, lower: true });
  }
  setReveal(!it);
  openPanel('p-add');
  (it ? f.name : f.username).focus();
}
function setReveal(on) {
  $('#add-form').password.type = on ? 'text' : 'password';
  $('#add-reveal').replaceChildren(icon(on ? 'eyeOff' : 'eye'));
}
$('#btn-add').onclick = () => openEditor();
$('#add-reveal').onclick = () => setReveal($('#add-form').password.type === 'password');
$('#add-gen').onclick = () => { $('#add-form').password.value = generatePassword({ ...gen, lower: true }); setReveal(true); };
$('#edit-delete').onclick = async () => {
  if (!editing || !confirm(`Supprimer « ${editing.name || 'sans nom'} » ?`)) return;
  try {
    await bg('delete', { id: editing._id });
    items = await fetchList();
    closePanels();
    render();
    toast('Entrée supprimée');
  } catch (ex) {
    $('.error', $('#add-form')).textContent = ex.message;
  }
};
$('#add-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('.error', f);
  if (!f.name.value.trim()) return (err.textContent = 'Le nom est obligatoire');
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  try {
    const item = withHistory(editing, {
      ...(editing || { type: 'login' }), // les champs non affichés ici (champs personnalisés…) sont conservés
      name: f.name.value.trim(),
      username: f.username.value.trim(),
      password: f.password.value,
      uris: f.uris.value.split('\n').map((s) => s.trim()).filter(Boolean),
      totp: f.totp.value.trim(),
      notes: f.notes.value,
    });
    if (iconHost(item) !== iconHost(editing || {})) { delete item.icon; delete item.iconTry; delete item.iconLazy; } // site changé
    await bg('save', { item });
    items = await fetchList();
    closePanels();
    render();
    toast(editing ? 'Modifié' : 'Enregistré');
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
};

$('#btn-settings').onclick = () => {
  $('#me-user').textContent = st.user;
  $('#me-server').textContent = parseServer(st.server).base; // jamais la clé d'accès
  $('#me-avatar').replaceChildren(initial(st.user));
  $('#me-avatar').style.background = avatarColor(st.user);
  $('#opt-lock').value = String(st.prefs.lock);
  $('#opt-inline').checked = st.prefs.inline;
  $('#opt-save').checked = st.prefs.savePrompt;
  $('#opt-window').checked = !!st.prefs.window;
  openPanel('p-settings');
};
const savePrefs = async () => {
  st.prefs = await bg('prefs', { prefs: { lock: +$('#opt-lock').value, inline: $('#opt-inline').checked, savePrompt: $('#opt-save').checked, window: $('#opt-window').checked } });
  toast('Réglages enregistrés');
};
for (const id of ['opt-lock', 'opt-inline', 'opt-save', 'opt-window']) $(`#${id}`).onchange = savePrefs;
$('#btn-forget').onclick = async () => {
  if (!confirm('Se déconnecter et effacer le cache local de ce navigateur ?')) return;
  await bg('forget');
  await route();
};

$('#ext-version').textContent = `Version installée : ${chrome.runtime.getManifest().version}`;
$('#btn-update').onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    const r = await bg('checkUpdate');
    const note = $('#ext-version');
    if (r.status === 'no_update') {
      note.textContent = `À jour : version ${r.current}`;
      toast('Extension à jour');
    } else if (r.status === 'update_available') {
      note.textContent = `Version ${r.latest || ''} trouvée : installation…`;
    } else {
      // une nouvelle version existe mais le navigateur limite les vérifications : passer par sa page
      note.replaceChildren(`Version ${r.latest} disponible (installée : ${r.current}). Brave l'installera seul sous peu, ou maintenant : `,
        h('button', { class: 'link inline-link', onclick: () => chrome.tabs.create({ url: 'chrome://extensions' }) }, 'page des extensions → Mettre à jour'));
    }
  } catch (ex) {
    toast(ex.message, false);
  } finally {
    b.disabled = false;
  }
};

// Page des raccourcis du navigateur (chrome:// est accepté par Brave, Chrome, Edge…)
$('#btn-shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

$('#btn-web').onclick = () => chrome.tabs.create({ url: webUrl(st.server) });
$('#btn-popout').hidden = isWindow;
$('#btn-popout').onclick = async () => {
  await bg('openWindow');
  window.close();
};
$('#btn-lock').onclick = async () => {
  await bg('lock');
  await route();
};
$('#btn-sync').onclick = async (e) => {
  const b = e.currentTarget;
  b.classList.add('spin');
  try {
    const changed = await bg('sync');
    items = await fetchList();
    st = await bg('status');
    renderStatus();
    render();
    toast(st.online ? (changed ? 'Données mises à jour' : 'Déjà à jour') : 'Serveur injoignable', st.online);
  } catch (ex) {
    toast(ex.message, false);
    if (ex.status === 401) await route();
  } finally {
    b.classList.remove('spin');
  }
};

// ------------------------------------------------------------------ démarrage

performance.mark('bp:script'); // repères lus par tools/bench-extension.mjs
hydrateIcons();
if (isWindow) document.body.classList.add('window');
// réponse demandée par boot.js dès le début du chargement (onglet, état, liste, premières icônes)
const boot = await window.bpBoot.catch(() => null);
const init = boot?.data || await bg('popup', { first: FIRST });
performance.mark('bp:init');
tab = init.tab;
await route(init);
// « Options » (clic droit sur l'icône) : ouvrir directement les réglages
if (new URLSearchParams(location.search).has('options') && st?.unlocked) $('#btn-settings').click();
