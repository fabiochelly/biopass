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

// Bandeau BioPass (shadow DOM fermé) : DOM.getDocument({ pierce }) traverse aussi les racines fermées
async function uiFind(t, pred) {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, t.sessionId);
  const all = []; const walk = (n) => { all.push(n); for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c); }; walk(root);
  const cls = (n) => (n.attributes || [])[(n.attributes || []).indexOf('class') + 1] || '';
  const n = all.find((x) => x.nodeType === 1 && pred(x, cls(x)));
  if (!n) throw new Error('élément du bandeau introuvable');
  const { object } = await send('DOM.resolveNode', { backendNodeId: n.backendNodeId }, t.sessionId);
  const call = async (fn) => (await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, returnByValue: true }, t.sessionId)).result.value;
  return {
    text: () => call('function () { return this.value ?? this.textContent; }'),
    click: async () => { const { model } = await send('DOM.getBoxModel', { backendNodeId: n.backendNodeId }, t.sessionId); const q = model.border; await t.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2); },
  };
}
const byClass = (c) => (n, cls) => cls.split(' ').includes(c);
const byText = (txt) => (n) => (n.children || []).some((c) => c.nodeType === 3 && c.nodeValue === txt);

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

  // 2b. « Adresse e-mail » en autocomplete=off (Keycloak, Carrefour…) : pas confondu avec une adresse postale
  const eo = await tab('http://site.localhost:8766/email-off.html');
  const eoTab = await pop.js(`chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('email-off.html')).id)`);
  await bg({ type: 'fill', id: byName('Site principal')._id, tabId: eoTab }); await sleep(400);
  vals = await eo.js(`[document.getElementById('username').value, document.getElementById('password').value]`);
  check('« Adresse e-mail » en autocomplete=off rempli', vals[0] === 'alice' && vals[1] === 'alice-pw', JSON.stringify(vals));
  await send('Target.closeTarget', { targetId: eo.targetId });

  // 2b'. ForgeRock (Carrefour…) : un e-mail nommé « idToken1 » n'est pas un champ de code 2FA
  const fg = await tab('http://site.localhost:8766/forgerock.html');
  const fgTab = await pop.js(`chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('forgerock.html')).id)`);
  await fg.js(`document.getElementById('idToken2').focus()`);
  await bg({ type: 'fill', id: byName('Site principal')._id, tabId: fgTab }); await sleep(400);
  vals = await fg.js(`[document.getElementById('idToken1').value, document.getElementById('idToken2').value]`);
  check('ForgeRock : e-mail « idToken1 » rempli', vals[0] === 'alice' && vals[1] === 'alice-pw', JSON.stringify(vals));
  await send('Target.closeTarget', { targetId: fg.targetId });

  // 2c. Site qui ne retient que la frappe réelle (isTrusted) et remet son modèle en quittant le champ
  const tr = await tab('http://site.localhost:8766/trusted.html');
  const trTab = await pop.js(`chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('trusted.html')).id)`);
  await bg({ type: 'fill', id: byName('Site principal')._id, tabId: trTab }); await sleep(600);
  vals = await tr.js(`document.activeElement.blur(); [document.getElementById('email').value, document.getElementById('password').value]`);
  check('site sensible à la frappe réelle : e-mail et mot de passe conservés', vals[0] === 'alice' && vals[1] === 'alice-pw', JSON.stringify(vals));
  await send('Target.closeTarget', { targetId: tr.targetId });

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
  const gpw = await uiFind(g, byClass('mono'));
  check('bandeau : mot de passe à demi masqué', (await gpw.text()) === 'No••••••42', await gpw.text());
  await (await uiFind(g, byClass('eye'))).click(); await sleep(200);
  check('bandeau : œil → mot de passe en clair', (await gpw.text()) === 'NouveauMotDePasse!42', await gpw.text());
  await (await uiFind(g, byClass('primary'))).click(); await sleep(1500);
  await g.shot('ext-07-after-save');
  const items2 = (await bg({ type: 'list' })).data;
  check('mot de passe Google mis à jour dans le coffre', items2.find((i) => i.name === 'Google')?.password === 'NouveauMotDePasse!42', items2.find((i) => i.name === 'Google')?.password);

  // 7b. Nouvel identifiant : portée de la correspondance choisie dans le bandeau
  const nv = await tab('http://login.nouveau.localhost:8766/simple.html');
  await nv.activate();
  await nv.js(`document.querySelector('[name=login]').value = 'carole'; document.querySelector('[name=pwd]').value = 'Carole-pw-2026'`);
  const sb = await nv.rect('button'); await nv.click(sb.x, sb.y); await sleep(2000);
  await nv.shot('ext-07b-add-banner');
  const siteIn = await uiFind(nv, byClass('inp'));
  check('bandeau « enregistrer » : domaine proposé par défaut', (await siteIn.text()) === 'nouveau.localhost', await siteIn.text());
  check('bandeau : identifiant pré-rempli', (await (await uiFind(nv, byClass('cin'))).text()) === 'carole');
  await (await uiFind(nv, byClass('scope'))).click(); await sleep(150);
  await nv.shot('ext-07b2-add-banner-scope');
  await (await uiFind(nv, byText('URL exacte'))).click(); await sleep(100);
  check('bandeau : URL exacte proposée', (await siteIn.text()) === 'login.nouveau.localhost:8766/simple.html', await siteIn.text());
  await (await uiFind(nv, byText('Hôte'))).click(); await sleep(100);
  check('bandeau : hôte proposé', (await siteIn.text()) === 'login.nouveau.localhost:8766', await siteIn.text());
  await (await uiFind(nv, byClass('primary'))).click(); await sleep(1500);
  const added = (await bg({ type: 'list' })).data.find((i) => i.username === 'carole');
  check('nouvel identifiant enregistré avec la portée « hôte »', added?.match === 'host' && added.uris?.[0] === 'http://login.nouveau.localhost:8766' && added.password === 'Carole-pw-2026', JSON.stringify(added));
  const nvTab = async (u) => { await nv.go(u); return pop.js(`chrome.tabs.query({}).then(t => t.find(x => x.url?.includes('nouveau.localhost')).id)`); };
  let nvId = await nvTab('http://autre.nouveau.localhost:8766/simple.html');
  await bg({ type: 'command', name: 'autofill', tabId: nvId }); await sleep(400);
  check('portée « hôte » : pas proposé sur un autre sous-domaine', (await nv.js(`document.querySelector('[name=pwd]').value`)) === '');
  nvId = await nvTab('http://login.nouveau.localhost:8766/simple.html');
  await bg({ type: 'command', name: 'autofill', tabId: nvId }); await sleep(400);
  check('portée « hôte » : rempli sur son hôte', (await nv.js(`document.querySelector('[name=pwd]').value`)) === 'Carole-pw-2026');

  // 7b''. Compte existant + connexion sans identifiant : « Ajouter » proposé d'abord, « Modifier » au choix
  const nv2 = await tab('http://login.nouveau.localhost:8766/simple.html');
  await nv2.activate();
  await nv2.js(`document.querySelector('[name=pwd]').value = 'Carole-pw-2027'`);
  const sb3 = await nv2.rect('button'); await nv2.click(sb3.x, sb3.y); await sleep(2000);
  check('compte existant, identifiant inconnu : « Ajouter » par défaut', (await (await uiFind(nv2, byClass('cin'))).text()) === '');
  await nv2.shot('ext-07b4-banner-add-tab');
  await (await uiFind(nv2, byText('Modifier'))).click(); await sleep(200);
  await nv2.shot('ext-07b5-banner-update-tab');
  const acctUser = await uiFind(nv2, (n, c) => c === 'u' && byText('carole')(n));
  check('« Modifier » : le compte du site est proposé', (await acctUser.text()) === 'carole');
  await (await uiFind(nv2, byClass('primary'))).click(); await sleep(1500);
  const carole = (await bg({ type: 'list' })).data.filter((i) => i.username === 'carole');
  check('« Modifier » : mot de passe du compte choisi remplacé, sans doublon', carole.length === 1 && carole[0].password === 'Carole-pw-2027' && carole[0].history?.[0]?.password === 'Carole-pw-2026', JSON.stringify(carole));
  await send('Target.closeTarget', { targetId: nv2.targetId });

  // 7b'. Identifiant non détecté : saisi dans le bandeau avant l'enregistrement
  const sans = await tab('http://sans.localhost:8766/simple.html');
  await sans.activate();
  await sans.js(`document.querySelector('[name=pwd]').value = 'Dora-pw-2026'`);
  const sb2 = await sans.rect('button'); await sans.click(sb2.x, sb2.y); await sleep(2000);
  const who = await uiFind(sans, byClass('cin'));
  check('bandeau : identifiant vide proposé à la saisie', (await who.text()) === '');
  await sans.shot('ext-07b3-add-banner-no-user');
  await who.click(); await sans.type('dora@example.com'); await sleep(100);
  await (await uiFind(sans, byClass('primary'))).click(); await sleep(1500);
  const dora = (await bg({ type: 'list' })).data.find((i) => i.password === 'Dora-pw-2026');
  check('identifiant saisi dans le bandeau enregistré', dora?.username === 'dora@example.com', JSON.stringify(dora));
  await send('Target.closeTarget', { targetId: sans.targetId }); // onglet en trop : décale les onglets rendus en arrière-plan

  // 7b''. Refus : le bandeau ne revient pas tant que l'on reste sur le formulaire
  const ref = await tab('http://refus.localhost:8766/simple.html');
  await ref.activate();
  await ref.js(`document.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
    document.querySelector('form').insertAdjacentHTML('beforeend', '<button type=button id=oeil>Afficher</button>');
    document.querySelector('[name=login]').value = 'erin'; document.querySelector('[name=pwd]').value = 'Refus-pw-1'`);
  const refSub = await ref.rect('button:not(#oeil)'), refEye = await ref.rect('#oeil');
  const refHas = () => uiFind(ref, byClass('save')).then(() => true, () => false);
  await ref.click(refSub.x, refSub.y); await sleep(1100);
  check('refus : bandeau proposé à la première soumission', await refHas());
  await (await uiFind(ref, byClass('x'))).click(); await sleep(200);
  check('refus : bandeau fermé par « Plus tard »', !(await refHas()));
  await ref.click(refEye.x, refEye.y); await sleep(1100);
  check('refus : pas de nouveau bandeau en cliquant ailleurs sur le formulaire', !(await refHas()));
  await ref.click(refSub.x, refSub.y); await sleep(1100);
  check('refus : pas de nouveau bandeau en resoumettant le même mot de passe', !(await refHas()));
  await ref.js(`document.querySelector('[name=pwd]').value = 'Refus-pw-2'`);
  await ref.click(refEye.x, refEye.y); await sleep(1100);
  check('refus : mot de passe retouché, simple clic ailleurs : toujours rien', !(await refHas()));
  await ref.go('http://refus.localhost:8766/simple.html');
  await ref.js(`document.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
    document.querySelector('[name=login]').value = 'erin'; document.querySelector('[name=pwd]').value = 'Refus-pw-1'`);
  await ref.click(refSub.x, refSub.y); await sleep(1100);
  check('refus : mémorisé après rechargement de la page', !(await refHas()));
  await ref.js(`document.querySelector('[name=pwd]').value = 'Refus-pw-3'`);
  await ref.click(refSub.x, refSub.y); await sleep(1100);
  check('refus : un autre mot de passe soumis est proposé', await refHas());
  // bandeau ouvert : un clic sur la page, même mot de passe, ne le recrée pas (saisie conservée)
  const refWho = await uiFind(ref, byClass('cin'));
  await refWho.click(); await ref.type('-bis'); await sleep(100);
  await ref.click(10, 10); await ref.click(refSub.x, refSub.y); await sleep(1100);
  check('bandeau ouvert : pas recréé, saisie conservée', (await (await uiFind(ref, byClass('cin'))).text()) === 'erin-bis', await (await uiFind(ref, byClass('cin'))).text());
  await send('Target.closeTarget', { targetId: ref.targetId });

  // 7c. Clés d'accès (WebAuthn) : création, connexion (bandeau, puis menu d'une demande conditionnelle), clé exclue.
  // La page vérifie elle-même attestation et signatures (tools/test-sites/passkey.html).
  const pk = await tab('http://pk.localhost:8766/passkey.html');
  await pk.activate();
  const pkClick = async (sel) => { const r = await pk.rect(sel); await pk.click(r.x, r.y); };
  const pkState = (k) => pk.js(`state.${k}`);
  await pkClick('#reg'); await sleep(800);
  await pk.shot('ext-07c-passkey-create');
  await (await uiFind(pk, byClass('primary'))).click(); await sleep(1500);
  let st = await pkState('reg');
  check('clé d’accès créée (attestation valide pour la page)', st?.instance && st.type === 'webauthn.create' && st.origin === 'http://pk.localhost:8766'
    && st.challengeOk && st.rpHashOk && st.flags === 0x5d && st.alg === -7 && st.rk === true && st.json, JSON.stringify(st));
  const pkItem = (await bg({ type: 'list' })).data.find((i) => i.name === 'Test RP');
  check('clé d’accès rangée dans une nouvelle entrée', pkItem?.username === 'dave' && pkItem.passkeys?.length === 1 && pkItem.passkeys[0].rpId === 'pk.localhost'
    && pkItem.passkeys[0].credentialId === st?.id, JSON.stringify(pkItem?.passkeys?.map(({ key, ...p }) => p)));
  await pkClick('#login'); await sleep(800);
  await pk.shot('ext-07d-passkey-login');
  await (await uiFind(pk, byClass('pkey'))).click(); await sleep(1000);
  st = await pkState('login');
  check('connexion par clé d’accès (bandeau) : signature vérifiée par la page', st?.ok && st.sameId && st.type === 'webauthn.get' && st.origin === 'http://pk.localhost:8766'
    && st.challengeOk && st.user === '1,2,3,4', JSON.stringify(st));
  await pkClick('#cond'); await sleep(500);
  await pkClick('#user'); await sleep(800);
  await pk.shot('ext-07e-passkey-conditional');
  await (await uiFind(pk, byText('Clé d\'accès · dave'))).click(); await sleep(1000);
  st = await pkState('cond');
  check('connexion par clé d’accès (menu sous le champ, demande conditionnelle)', st?.ok && st.sameId && st.challengeOk, JSON.stringify(st));
  await pkClick('#again'); await sleep(1000);
  st = await pkState('again');
  check('clé d’accès déjà dans BioPass : InvalidStateError', st?.error === 'InvalidStateError', JSON.stringify(st));
  const pkHas = async (c) => !!(await uiFind(pk, byClass(c)).catch(() => null));
  await pkClick('#login'); await sleep(800);
  check('bandeau de connexion léger : le site, le compte et son bouton, « Autre méthode »', await pkHas('pkey') && !(await pkHas('field'))
    && !!(await uiFind(pk, byText('pk.localhost'))) && !!(await uiFind(pk, byText('Se connecter'))) && !!(await uiFind(pk, byText('Autre méthode'))));
  await (await uiFind(pk, byClass('x'))).click(); await sleep(300);
  st = await pkState('login');
  check('bandeau annulé : NotAllowedError pour le site', st?.error === 'NotAllowedError', JSON.stringify(st));
  // Identifiant différent : choix de l'entrée sur une ligne ; identifiant connu, aucune question (vu plus haut)
  await pkClick('#reg'); await sleep(800);
  check('création, entrée évidente : aucun choix à faire', !(await pkHas('to')));
  await (await uiFind(pk, byClass('x'))).click(); await sleep(300);
  await bg({ type: 'save', item: { ...(await bg({ type: 'list' })).data.find((i) => i.name === 'Test RP'), username: 'autre' } });
  await pkClick('#reg'); await sleep(800);
  await pk.shot('ext-07f-passkey-choose-entry');
  check('création, identifiant différent : choix de l’entrée', await pkHas('to'));
  await (await uiFind(pk, byClass('x'))).click(); await sleep(300);
  // Coffre verrouillé : la demande reprend seule une fois déverrouillé
  await bg({ type: 'lock' });
  await pk.js('state.login = null');
  await pkClick('#login'); await sleep(800);
  await pk.shot('ext-07g-passkey-locked');
  check('coffre verrouillé : proposition de déverrouiller, sans compte', !(await pkHas('pkey')) && !!(await uiFind(pk, byText('Déverrouiller'))));
  await bg({ type: 'unlock', password: 'ext-password-123' }); await sleep(1800);
  check('déverrouillé : le compte apparaît sans autre clic', await pkHas('pkey'));
  await (await uiFind(pk, byClass('pkey'))).click(); await sleep(1000);
  st = await pkState('login');
  check('connexion après déverrouillage', st?.ok && st.sameId, JSON.stringify(st));
  // Plusieurs comptes, clair puis sombre (captures seulement) : une carte et un bouton par compte
  const pkMany = (await bg({ type: 'list' })).data.find((i) => i.name === 'Test RP');
  await bg({ type: 'save', item: { ...pkMany, passkeys: [...pkMany.passkeys, { ...pkMany.passkeys[0], credentialId: 'AAAA', userHandle: 'BBBB', userName: 'une.adresse.vraiment.tres.longue@exemple-de-domaine.fr' }] } });
  await pkClick('#login'); await sleep(800);
  await pk.shot('ext-07h-passkey-accounts');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, pk.sessionId); await sleep(300);
  await pk.shot('ext-07i-passkey-accounts-dark');
  await send('Emulation.setEmulatedMedia', { features: [] }, pk.sessionId);
  await (await uiFind(pk, byClass('x'))).click(); await sleep(300);
  await pkClick('#login'); await sleep(800);
  await (await uiFind(pk, byText('Autre méthode'))).click(); await sleep(500);
  check('« Autre méthode » ferme le bandeau et laisse faire le navigateur', !(await pkHas('banner')));
  await send('Target.closeTarget', { targetId: pk.targetId });

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
