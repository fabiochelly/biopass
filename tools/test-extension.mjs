import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
// Test de bout en bout de l'extension dans Chromium headless (voir tools/test-all.sh).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const S = process.env.S || mkdtempSync(tmpdir() + '/biopass-ext-');
const EXT = new URL('../extension', import.meta.url).pathname;
const port = 9900 + Math.floor(Math.random() * 90);
rmSync(`${S}/chrome-ext`, { recursive: true, force: true });
const chrome = spawn('chromium', [`--remote-debugging-port=${port}`, `--user-data-dir=${S}/chrome-ext`, '--headless=new', '--no-first-run',
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1100,750', '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver; for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => ws.onopen = r);
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  else if (d.method === 'Runtime.consoleAPICalled' && d.params.type !== 'log') logs.push(d.params.type + ' ' + d.params.args.map((a) => a.value ?? a.description).join(' ')); };
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; pend.set(i, (d) => d.error ? j(new Error(method + ': ' + d.error.message)) : r(d.result)); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

async function tab(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(900);
  const t = {
    targetId, sessionId,
    js: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    go: async (u) => { await send('Page.navigate', { url: u }, sessionId); await sleep(900); },
    shot: async (name) => { mkdirSync(`${S}/shots`, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(`${S}/shots/${name}.png`, Buffer.from(r.data, 'base64')); },
    click: async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId); },
    type: async (text) => send('Input.insertText', { text }, sessionId),
    rect: async (sel) => t.js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, bottom: r.bottom, left: r.left }; })()`),
    activate: () => send('Target.activateTarget', { targetId }),
  };
  return t;
}

let ok = 0; const check = (name, cond, extra = '') => { if (cond) { ok++; console.log('  ✓', name); } else { console.log('  ✗', name, extra); process.exitCode = 1; } };
try {
  await sleep(1500);
  const { targetInfos } = await send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  assert(sw, 'service worker introuvable : ' + JSON.stringify(targetInfos.map((t) => t.url)));
  const extId = new URL(sw.url).host;
  console.log('Extension', extId);
  const pop = await tab(`chrome-extension://${extId}/popup.html`);
  const bg = (msg) => pop.js(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
  await pop.shot('ext-01-setup');
  let r = await bg({ type: 'login', server: process.env.BP_SERVER || 'http://127.0.0.1:8765', user: 'ext', password: 'ext-password-123' });
  check('connexion depuis l’extension', r.data === true, JSON.stringify(r));
  await pop.go(`chrome-extension://${extId}/popup.html`); await sleep(500);
  await pop.shot('ext-02-popup');

  // 1. Formulaire simple : menu sous le champ + clic réel
  const site = await tab('http://site.localhost:8766/simple.html');
  await site.activate();
  const f = await site.rect('input[name=login]');
  await site.click(f.x, f.y); await sleep(700);
  await site.shot('ext-03-inline-menu');
  // le premier élément du menu est sous le champ (~ en-tête 32px + 22px)
  await site.click(f.left + 60, f.bottom + 6 + 32 + 23); await sleep(500);
  let vals = await site.js(`[document.querySelector('[name=login]').value, document.querySelector('[name=pwd]').value]`);
  check('remplissage via le menu (simple)', vals[0] && vals[1] && ['alice-pw', 'bob-pw'].includes(vals[1]), JSON.stringify(vals));
  await site.shot('ext-04-filled');
  const menuAt = (y) => site.js(`document.elementFromPoint(${f.left + 60}, ${y})?.tagName === 'BIOPASS-UI'`);
  const row1 = f.bottom + 6 + 32 + 23, row2 = row1 + 46;
  check('menu fermé après le choix (pas de réaffichage)', !(await menuAt(row1)));
  // filtrage par le début de l'identifiant saisi
  await site.js(`document.querySelector('[name=login]').value=''; document.querySelector('[name=pwd]').value=''; document.activeElement.blur()`);
  await site.click(f.x, f.y); await sleep(500);
  check('menu : deux comptes quand le champ est vide', (await menuAt(row1)) && (await menuAt(row2)));
  await site.type('b'); await sleep(300);
  check('menu filtré par « b » : un seul compte', (await menuAt(row1)) && !(await menuAt(row2)));
  await site.type('zz'); await sleep(300);
  check('menu fermé sans correspondance', !(await menuAt(row1)));
  for (let k = 0; k < 2; k++) await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, site.sessionId).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, site.sessionId));
  await sleep(300);
  check('menu rouvert en effaçant (« b »)', (await menuAt(row1)) && !(await menuAt(row2)));
  await site.js(`document.querySelector('[name=login]').value=''; document.activeElement.blur()`);

  // 2. Remplissage depuis la popup (onglet ciblé) avec une entrée précise
  await site.js(`document.querySelector('[name=login]').value=''; document.querySelector('[name=pwd]').value=''; document.activeElement.blur()`);
  const items = (await bg({ type: 'list' })).data;
  const byName = (n) => items.find((i) => i.name === n);
  const siteTabId = await pop.js(`chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('site.localhost')).id)`);
  r = await bg({ type: 'fill', id: byName('Site principal')._id, tabId: siteTabId }); await sleep(400);
  vals = await site.js(`[document.querySelector('[name=login]').value, document.querySelector('[name=pwd]').value]`);
  check('remplissage depuis la popup', vals[0] === 'alice' && vals[1] === 'alice-pw', JSON.stringify(vals));

  // 3. Entrée d'un autre domaine : refusée sans forçage
  await site.js(`document.querySelector('[name=login]').value=''; document.querySelector('[name=pwd]').value=''`);
  await bg({ type: 'fill', id: byName('Shadow')._id, tabId: siteTabId }); await sleep(400);
  vals = await site.js(`document.querySelector('[name=pwd]').value`);
  check('entrée d’un autre domaine non remplie', vals === '', vals);

  // 3b. Raccourci « remplir » : dernier compte utilisé d'abord ; appuis enchaînés → compte suivant
  const press = async () => { await bg({ type: 'command', name: 'autofill', tabId: siteTabId }); await sleep(400); return site.js(`document.querySelector('[name=login]').value`); };
  const clear = () => site.js(`document.querySelector('[name=login]').value=''; document.querySelector('[name=pwd]').value=''`);
  await clear();
  const seen = [await press(), await press(), await press()];
  check('raccourci : 1er appui = dernier compte utilisé sur ce site (alice)', seen[0] === 'alice', JSON.stringify(seen));
  check('raccourci : appuis enchaînés → compte suivant, puis retour au premier', seen[1] === 'bob' && seen[2] === 'alice', JSON.stringify(seen));
  await press(); // → bob, qui devient le dernier utilisé
  await clear(); // page rechargée / champ vidé
  const after = await press();
  check('raccourci : après rechargement, le dernier compte utilisé (bob) revient en premier', after === 'bob', after);
  r = await bg({ type: 'command', name: 'generate', tabId: siteTabId }); await sleep(400);
  const offscreen = (await send('Target.getTargets')).targetInfos.some((t) => t.url.endsWith('/offscreen.html'));
  check('raccourci : mot de passe généré copié (document hors écran)', !r.error && offscreen, JSON.stringify(r));

  // 4. iframe d'un autre domaine : le mot de passe du site hôte ne doit pas y aller, celui de l'iframe oui
  const fr = await tab('http://site.localhost:8766/frame.html');
  const frTabId = await pop.js(`chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('frame.html')).id)`);
  await bg({ type: 'fill', id: byName('Site principal')._id, tabId: frTabId, force: true }); await sleep(400);
  const ifr = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'iframe' && t.url.includes('auth.localhost'));
  const { sessionId: ifs } = await send('Target.attachToTarget', { targetId: ifr.targetId, flatten: true });
  const inFrame = async () => (await send('Runtime.evaluate', { expression: `document.querySelector('[name=pwd]').value`, returnByValue: true }, ifs)).result.value;
  check('pas de fuite vers une iframe d’un autre domaine (même forcé)', (await inFrame()) === '', await inFrame());
  await bg({ type: 'fill', id: byName('Auth iframe')._id, tabId: frTabId }); await sleep(400);
  check('remplissage dans l’iframe de son propre domaine', (await inFrame()) === 'iframe-pw', await inFrame());

  // 5. Shadow DOM
  const sh = await tab('http://shadow.localhost:8766/shadow.html');
  const shTab = await pop.js(`chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('shadow.html')).id)`);
  await bg({ type: 'fill', id: byName('Shadow')._id, tabId: shTab }); await sleep(400);
  vals = await sh.js(`[...document.querySelector('x-login').shadowRoot.querySelectorAll('input')].map(i => i.value)`);
  check('shadow DOM', vals[0] === 'shadow-user' && vals[1] === 'shadow-pw', JSON.stringify(vals));

  // 6. Champs type React (événements input)
  const re = await tab('http://react.localhost:8766/react.html');
  const reTab = await pop.js(`chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('react.html')).id)`);
  await bg({ type: 'fill', id: byName('React')._id, tabId: reTab }); await sleep(300);
  vals = await re.js(`document.getElementById('b').click(); document.getElementById('log').textContent`);
  check('framework (événements input) informé', vals === '{"e":"r@x.fr","p":"react-pw"}', vals);

  // 7. Connexion en deux étapes + proposition d'enregistrement d'un nouveau mot de passe
  const g = await tab('http://google.localhost:8766/step1.html');
  await g.activate();
  const e1 = await g.rect('#identifierId');
  await g.click(e1.x, e1.y); await sleep(600);
  await g.shot('ext-05-step1-menu');
  await g.click(e1.left + 60, e1.bottom + 6 + 32 + 23); await sleep(400);
  vals = await g.js(`document.getElementById('identifierId').value`);
  check('étape 1 : identifiant seul rempli', vals === 'alice@example.com', vals);
  const nb = await g.rect('#next'); await g.click(nb.x, nb.y); await sleep(1200);
  const p2 = await g.rect('input[type=password]');
  await g.click(p2.x, p2.y); await sleep(200);
  await g.js(`document.querySelector('biopass-ui') && document.activeElement.blur()`);
  await g.click(p2.x, p2.y); await g.type('NouveauMotDePasse!42'); await sleep(200);
  const go = await g.rect('#go'); await g.click(go.x, go.y); await sleep(1800);
  await g.shot('ext-06-save-banner');
  const banner = await g.js(`!!document.querySelector('biopass-ui')`);
  check('bandeau « mettre à jour » affiché après connexion', banner);
  // bouton principal du bandeau : en haut à droite (top 16 + ~ 105px), largeur 340
  await g.click(1000 - 16 - 16 - 50, 16 + 16 + 24 + 6 + 40 + 18); await sleep(1500);
  await g.shot('ext-07-after-save');
  const items2 = (await bg({ type: 'list' })).data;
  check('mot de passe Google mis à jour dans le coffre', items2.find((i) => i.name === 'Google')?.password === 'NouveauMotDePasse!42', items2.find((i) => i.name === 'Google')?.password);

  // 8. Verrouillage
  await bg({ type: 'lock' });
  r = await bg({ type: 'status' });
  check('verrouillage', r.data.unlocked === false);
  await pop.go(`chrome-extension://${extId}/popup.html`); await sleep(400);
  await pop.shot('ext-08-locked');
  r = await bg({ type: 'unlock', password: 'faux' });
  check('mauvais mot de passe refusé', !!r.error, JSON.stringify(r));
  r = await bg({ type: 'unlock', password: 'ext-password-123' });
  check('déverrouillage', r.data === true, JSON.stringify(r));
  // 9. Modifier une entrée depuis la popup (formulaire réel), historique conservé, puis suppression
  await pop.go(`chrome-extension://${extId}/popup.html`); await sleep(700);
  await pop.js(`document.querySelector('#q').value='Shadow'; document.querySelector('#q').dispatchEvent(new Event('input'))`); await sleep(200);
  await pop.js(`document.querySelector('.item [title=Modifier]').click()`); await sleep(300);
  const before = await pop.js(`document.querySelector('#add-form').password.value`);
  await pop.js(`const f = document.querySelector('#add-form'); f.password.value = 'nouveau-shadow'; f.notes.value = 'modifié depuis la popup'; f.requestSubmit()`); await sleep(1200);
  let all = (await bg({ type: 'list' })).data;
  const edited = all.find((i) => i.name === 'Shadow');
  check('modification depuis la popup', before === 'shadow-pw' && edited?.password === 'nouveau-shadow' && edited?.notes === 'modifié depuis la popup' && edited.uris?.[0] === 'shadow.localhost', JSON.stringify(edited));
  check('historique du mot de passe conservé', edited?.history?.[0]?.password === 'shadow-pw');
  await pop.js(`window.confirm = () => true; document.querySelector('#q').value='Shadow'; document.querySelector('#q').dispatchEvent(new Event('input'))`); await sleep(200);
  await pop.js(`document.querySelector('.item [title=Modifier]').click()`); await sleep(300);
  await pop.js(`document.querySelector('#edit-delete').click()`); await sleep(1200);
  all = (await bg({ type: 'list' })).data;
  check('suppression depuis la popup', !all.some((i) => i.name === 'Shadow'));
  await pop.go(`chrome-extension://${extId}/popup.html`); await sleep(600);
  await pop.activate(); // une popup est toujours au premier plan (un onglet caché ne produit pas d'image)
  await pop.js(`document.querySelector('#q').value='site'; document.querySelector('#q').dispatchEvent(new Event('input'))`); await sleep(200);
  const found = await pop.js(`[...document.querySelectorAll('.item .n')].map((n) => n.textContent)`);
  check('recherche dans la popup', found.length === 2 && found.every((n) => /^Site/.test(n)), JSON.stringify(found));
  await pop.shot('ext-09-popup-search');

  // Option « Ouvrir BioPass dans une fenêtre » : plus de bulle, une seule fenêtre à la fois
  await bg({ type: 'prefs', prefs: { window: true } });
  check('option fenêtre : bulle désactivée', (await pop.js(`chrome.action.getPopup({})`)) === '');
  await bg({ type: 'openWindow' }); await sleep(800); await bg({ type: 'openWindow' }); await sleep(800);
  const wins = (await send('Target.getTargets')).targetInfos.filter((t) => t.url.endsWith('popup.html?window=1'));
  check('option fenêtre : une seule fenêtre BioPass', wins.length === 1, String(wins.length));
  for (const w of wins) await send('Target.closeTarget', { targetId: w.targetId });
  await bg({ type: 'prefs', prefs: { window: false } });
  check('option fenêtre désactivée : bulle rétablie', (await pop.js(`chrome.action.getPopup({})`)).endsWith('popup.html'));

  // Icônes chargées à la demande (la liste arrive sans elles) et conservées à la modification
  const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const iconId = (await bg({ type: 'save', item: { type: 'login', name: 'Icône', username: 'ico', password: 'x', uris: ['icone.localhost'], icon: PX } })).data;
  await pop.go(`chrome-extension://${extId}/popup.html`); await sleep(600);
  await pop.js(`document.querySelector('#q').value='Icône'; document.querySelector('#q').dispatchEvent(new Event('input'))`); await sleep(300);
  check('popup : icône chargée à la demande', (await pop.js(`document.querySelector('.item .avatar.site img')?.src`)) === PX);
  const listed = (await bg({ type: 'list' })).data.find((i) => i._id === iconId);
  check('popup : liste envoyée sans les icônes', listed && !listed.icon && listed.iconLazy === 1, JSON.stringify(listed));
  await bg({ type: 'save', item: { ...listed, notes: 'modifié' } });
  check('popup : icône conservée après modification', (await bg({ type: 'icons', ids: [iconId] })).data[iconId] === PX);

  // Extension rechargée (mise à jour) : les onglets déjà ouverts remplissent sans recharger la page
  await site.go('http://site.localhost:8766/simple.html');
  await send('Extensions.loadUnpacked', { path: EXT }); await sleep(2500); // = mise à jour (même id)
  await site.activate();
  await site.js(`document.activeElement?.blur(); document.querySelector('[name=login]').value=''`);
  await site.click(f.x, f.y); await sleep(800);
  check('onglet ouvert avant une mise à jour : menu sans recharger la page', await menuAt(row1));
  console.log(`${ok} vérifications OK`);
} catch (e) { console.log('ERREUR', e.stack); process.exitCode = 1; }
finally { if (logs.length) console.log('Console:\n' + logs.join('\n')); ws.close(); chrome.kill(); }
