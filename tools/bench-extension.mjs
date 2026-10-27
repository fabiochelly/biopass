// Banc de performance de l'extension (Chromium headless) : ouverture du popup à froid / à chaud,
// menu et remplissage dans une page, frappe dans la recherche ; normal puis processeur ralenti ×4.
// Lancé par tools/bench-extension.sh (serveur PHP + coffre de 800 entrées).
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const S = mkdtempSync(tmpdir() + '/biopass-bench-');
const EXT = process.env.EXT || new URL('../extension', import.meta.url).pathname; // EXT=… : comparer une autre version
const RUNS = +(process.env.RUNS || 5);
const port = 9800 + Math.floor(Math.random() * 90);
const chrome = spawn('chromium', [`--remote-debugging-port=${port}`, `--user-data-dir=${S}/p`, '--headless=new', '--no-first-run',
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1100,750', '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver; for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; pend.set(i, (d) => (d.error ? j(new Error(method + ': ' + d.error.message)) : r(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

// Repères posés dans le popup dès le début du document : première ligne visible, premières icônes décodées.
const PROBE = `window.__t = {}; (function loop() {
  const t = performance.now();
  if (!__t.rows && document.querySelector('#results .item')) __t.rows = t;
  if (!__t.icons) { const imgs = [...document.querySelectorAll('#results .item img')].slice(0, 8);
    if (imgs.length >= 8 && imgs.every((i) => i.complete && i.naturalWidth)) __t.icons = t; }
  if (!__t.icons) requestAnimationFrame(loop);
})();`;

async function attach(url, probe = '') {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  if (probe) await send('Page.addScriptToEvaluateOnNewDocument', { source: probe }, sessionId);
  const t = {
    targetId, sessionId,
    js: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    go: (u) => send('Page.navigate', { url: u }, sessionId),
    cpu: (rate) => send('Emulation.setCPUThrottlingRate', { rate }, sessionId),
    close: () => send('Target.closeTarget', { targetId }),
  };
  if (url) { await t.go(url); await sleep(600); }
  return t;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fmt = (v) => (v == null ? '—' : `${Math.round(v)} ms`);
const results = [];
const row = (label, values) => { results.push([label, values]); console.log(label.padEnd(58), values.map(fmt).join('   ')); };

try {
  let sw;
  for (let i = 0; i < 50 && !sw; i++) {
    await sleep(200);
    sw = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  }
  const extId = new URL(sw.url).host;
  const POPUP = `chrome-extension://${extId}/popup.html`;
  const ctl = await attach(POPUP);
  const bg = (msg) => ctl.js(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
  let r = await bg({ type: 'login', server: process.env.BP_SERVER, user: 'ext', password: 'ext-password-123' });
  if (r?.data !== true) throw new Error('connexion : ' + JSON.stringify(r));
  await bg({ type: 'prefs', prefs: { lock: -1 } });
  console.log('Entrées :', (await bg({ type: 'list' })).data.length);
  await send('ServiceWorker.enable', {}, ctl.sessionId);
  const stopWorker = async () => { await send('ServiceWorker.stopAllWorkers', {}, ctl.sessionId); await sleep(300); };

  // Démarrage du service worker : repères posés par background.js (ms depuis son lancement)
  {
    const boots = [];
    for (let i = 0; i < RUNS; i++) { await stopWorker(); const t0 = Date.now(); const r = await bg({ type: 'perf' }); const b = r?.data || {}; b.total = Date.now() - t0; boots.push(b); }
    const keys = Object.keys(boots[0]).filter((k) => k !== 'started');
    console.log('Démarrage du service worker (médianes) :', keys.map((k) => `${k} ${Math.round(median(boots.map((b) => b[k])))}`).join(' · '));
  }

  // Service worker maintenu en vie tant que le coffre est ouvert : toujours le même après 40 s sans rien
  if (process.env.KEEPALIVE) {
    const a = (await bg({ type: 'perf' })).data?.started;
    await sleep(40000);
    const b = (await bg({ type: 'perf' })).data.started;
    console.log(a === b ? 'Service worker toujours actif après 40 s d’inactivité' : 'Service worker REDÉMARRÉ entre-temps');
  }

  const site = await attach('http://site.localhost:8766/simple.html');
  const siteTab = await ctl.js(`chrome.tabs.query({ url: 'http://site.localhost:8766/*' }).then((t) => t[0].id)`);

  // Captures du popup (SHOTS=dossier) : liste, recherche, éditeur, générateur, réglages ; clair et sombre
  if (process.env.SHOTS) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(process.env.SHOTS, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      const p = await attach(null);
      await send('Emulation.setDeviceMetricsOverride', { width: 380, height: 580, deviceScaleFactor: 2, mobile: false }, p.sessionId);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, p.sessionId);
      await p.go(POPUP); await sleep(900);
      const shot = async (name) => { await sleep(250); const r = await send('Page.captureScreenshot', { format: 'png' }, p.sessionId); writeFileSync(`${process.env.SHOTS}/${scheme}-${name}.png`, Buffer.from(r.data, 'base64')); };
      await shot('1-liste');
      await p.js(`document.querySelector('.item')?.dispatchEvent(new MouseEvent('mouseenter')); 0`);
      await p.js(`const q = document.querySelector('#q'); q.value = 'banque'; q.dispatchEvent(new Event('input')); 0`);
      await shot('2-recherche');
      await p.js(`document.querySelector('.item [title="Modifier"]')?.click(); 0`);
      await shot('3-editeur');
      await p.go(POPUP); await sleep(700);
      await p.js(`document.querySelector('#btn-gen').click(); 0`);
      await shot('4-generateur');
      await p.go(POPUP); await sleep(700);
      await p.js(`document.querySelector('#btn-settings').click(); 0`);
      await shot('5-reglages');
      await p.close();
    }
    console.log('Captures :', process.env.SHOTS);
  }

  // Profil CPU de l'ouverture à chaud du popup (PROFILE=1) : temps propre par fonction et par fichier
  if (process.env.PROFILE) {
    const p = await attach(null);
    await send('Profiler.enable', {}, p.sessionId);
    await send('Profiler.setSamplingInterval', { interval: 100 }, p.sessionId);
    await send('Profiler.start', {}, p.sessionId);
    await p.go(POPUP); await sleep(700);
    const { profile } = await send('Profiler.stop', {}, p.sessionId);
    const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
    const self = new Map(); const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
    for (const id of profile.samples) { const n = byNode.get(id); const cf = n.callFrame;
      const k = `${cf.functionName || '(anonyme)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + dt); }
    console.log('Profil (temps propre, ms) :');
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) if (!k.startsWith('(idle)')) console.log('   ', v.toFixed(1).padStart(6), k);
    await p.close();
  }

  for (const rate of [1, 4]) {
    console.log(`\n== Processeur ${rate === 1 ? 'normal' : 'ralenti ×' + rate}   (médiane de ${RUNS} essais : lignes   icônes)`);
    // --- popup
    for (const cold of [true, false]) {
      const rows = [], icons = [];
      for (let i = 0; i < RUNS; i++) {
        if (cold) await stopWorker();
        const p = await attach(null, PROBE);
        await p.cpu(rate);
        await p.go(POPUP); await sleep(rate * 1500);
        const t = await p.js(`({ ...window.__t, marks: Object.fromEntries(performance.getEntriesByType('mark').map((m) => [m.name, Math.round(m.startTime)])),
          nav: (({ responseEnd, domInteractive }) => ({ responseEnd: Math.round(responseEnd), domInteractive: Math.round(domInteractive) }))(performance.getEntriesByType('navigation')[0]) })`);
        rows.push(t.rows); icons.push(t.icons);
        if (process.env.DETAIL && i === RUNS - 1) console.log('   ', JSON.stringify({ ...t.nav, ...t.marks }));
        await p.close();
      }
      row(`Popup ${cold ? 'à froid (service worker arrêté)' : 'à chaud'} : 1re ligne, icônes`, [median(rows), median(icons)]);
    }
    // --- recherche (popup ouvert, chaud)
    {
      const p = await attach(POPUP); await sleep(800); await p.cpu(rate);
      const t = await p.js(`(async () => {
        const q = document.querySelector('#q'); const sync = [], frame = [];
        const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
        for (const word of ['banque', 'alice', 'git', 'claire12', 'zzz', 'mail dav']) {
          for (let i = 1; i <= word.length; i++) {
            const t0 = performance.now();
            q.value = word.slice(0, i); q.dispatchEvent(new Event('input'));
            sync.push(performance.now() - t0);
            await raf(); frame.push(performance.now() - t0);
          }
          q.value = ''; q.dispatchEvent(new Event('input')); await raf(); await raf();
        }
        const m = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
        return [m([...sync]), Math.max(...sync), m([...frame]), Math.max(...frame)];
      })()`);
      row('Recherche, par frappe : calcul (médiane, pire)', t.slice(0, 2));
      row('Recherche, par frappe : jusqu’à l’image affichée (médiane, pire)', t.slice(2));
      await p.close();
    }
    // --- page : menu au focus, remplissage par le menu et par Ctrl+Espace
    await site.cpu(rate);
    for (const cold of [true, false]) {
      const menu = [], fillMenu = [], fillKey = [];
      for (let i = 0; i < RUNS; i++) {
        await site.go('http://site.localhost:8766/simple.html'); await sleep(700 * rate);
        if (cold) await stopWorker();
        menu.push(await site.js(`(async () => {
          const f = document.querySelector('[name=login]'); const r = f.getBoundingClientRect();
          const t0 = performance.now(); f.focus();
          for (;;) { await new Promise((ok) => requestAnimationFrame(ok));
            if (document.elementFromPoint(r.left + 60, r.bottom + 6 + 32 + 23)?.tagName === 'BIOPASS-UI') return performance.now() - t0;
            if (performance.now() - t0 > 5000) return null; }
        })()`));
        // clic réel sur le premier compte du menu
        const pos = await site.js(`(() => { const r = document.querySelector('[name=login]').getBoundingClientRect(); return [r.left + 60, r.bottom + 6 + 32 + 23]; })()`);
        await site.js(`window.__filled = null; document.querySelector('[name=pwd]').addEventListener('input', () => { window.__filled ??= performance.now(); }, { once: true }); window.__t0 = performance.now(); 0`);
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pos[0], y: pos[1], button: 'left', clickCount: 1 }, site.sessionId);
        await sleep(400 * rate);
        fillMenu.push(await site.js('window.__filled && window.__filled - window.__t0'));
        // Ctrl+Espace (même chemin que le raccourci)
        await site.go('http://site.localhost:8766/simple.html'); await sleep(700 * rate);
        if (cold) await stopWorker();
        await site.js(`document.querySelector('[name=login]').focus(); window.__filled = null; document.querySelector('[name=pwd]').addEventListener('input', () => { window.__filled ??= performance.now(); }, { once: true }); window.__t0 = performance.now(); 0`);
        await bg({ type: 'command', name: 'autofill', tabId: siteTab });
        await sleep(300 * rate);
        fillKey.push(await site.js('window.__filled && window.__filled - window.__t0'));
      }
      const label = cold ? 'à froid' : 'à chaud';
      row(`Page ${label} : menu sous le champ après le focus`, [median(menu)]);
      row(`Page ${label} : remplissage après clic dans le menu`, [median(fillMenu)]);
      row(`Page ${label} : remplissage par Ctrl+Espace`, [median(fillKey)]);
    }
    await site.cpu(1);
    // --- page lourde : coût synchrone du script de l'extension (focus d'un champ texte, clic sur un bouton)
    {
      const heavy = await attach('http://site.localhost:8766/heavy.html'); await sleep(800); await heavy.cpu(rate);
      // focus : les écouteurs de l'extension s'exécutent pendant l'appel. Clic : vrais clics (l'extension
      // ignore les clics simulés), chronométrés entre un écouteur avant et un écouteur après le sien.
      const focus = await heavy.js(`(async () => {
        const q = document.getElementById('q'); const f = [];
        for (let i = 0; i < 15; i++) {
          q.blur(); await new Promise((r) => setTimeout(r, 30));
          const t0 = performance.now(); q.focus(); f.push(performance.now() - t0);
        }
        return f;
      })()`);
      await heavy.js(`window.__c = []; addEventListener('click', () => { window.__c0 = performance.now(); }, true);
        addEventListener('click', (e) => { e.preventDefault(); __c.push(performance.now() - __c0); }); 0`);
      const pos = await heavy.js(`(() => { const r = document.getElementById('b').getBoundingClientRect(); return [r.x + 5, r.y + 5]; })()`);
      for (let i = 0; i < 15; i++) {
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pos[0], y: pos[1], button: 'left', clickCount: 1 }, heavy.sessionId);
        await sleep(40);
      }
      const clicks = await heavy.js('window.__c');
      const t = [median(focus), Math.max(...focus), median(clicks), Math.max(...clicks)];
      row('Page lourde (30 000 éléments) : focus d’un champ texte (médiane, pire)', t.slice(0, 2));
      row('Page lourde (30 000 éléments) : clic sur un bouton (médiane, pire)', t.slice(2));
      await heavy.close();
    }
  }
} catch (e) { console.log('ERREUR', e.stack); process.exitCode = 1; }
finally { ws.close(); chrome.kill(); await sleep(300); rmSync(S, { recursive: true, force: true }); }
