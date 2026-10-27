// Connexion permanente de l'extension : survit au redémarrage du navigateur et à l'expiration
// de la session serveur (reconnexion automatique sans mot de passe).
//   BP_SERVER='http://…/?k=…' node tools/test-extension-persist.mjs   (compte « ext » créé par seed-extension.mjs)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Vault } from '../server/web/assets/core.js';

const EXT = new URL('../extension', import.meta.url).pathname;
const PROFILE = mkdtempSync(tmpdir() + '/biopass-persist-');
const SERVER = process.env.BP_SERVER;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (name, ok, extra = '') => { console.log(ok ? '  ✓' : '  ✗', name, ok ? '' : extra); if (!ok) failed = true; };

async function launch() {
  const port = 9600 + Math.floor(Math.random() * 300);
  const proc = spawn('chromium', [`--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`, '--headless=new', '--no-first-run',
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, (d) => r(d.result)); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  let sw; for (let i = 0; i < 30 && !sw; i++) { sw = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('background.js')); if (!sw) await sleep(200); }
  const extId = new URL(sw.url).host;
  const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(800);
  const bg = async (msg) => (await send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage(${JSON.stringify(msg)})`, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  return { bg, close: async () => { await send('Browser.close').catch(() => {}); ws.close(); await sleep(800); proc.kill(); } };
}

try {
  let b = await launch();
  let r = await b.bg({ type: 'login', server: SERVER, user: 'ext', password: 'ext-password-123' });
  check('connexion', r.data === true, JSON.stringify(r));
  r = await b.bg({ type: 'status' });
  check('verrouillage « Jamais » par défaut', r.data.prefs.lock === -1, JSON.stringify(r.data.prefs));
  await b.close();

  b = await launch();
  r = await b.bg({ type: 'status' });
  check('toujours déverrouillé après redémarrage du navigateur', r.data.unlocked === true, JSON.stringify(r.data));
  r = await b.bg({ type: 'list' });
  check('entrées lisibles après redémarrage', r.data?.length > 0, JSON.stringify(r).slice(0, 200));

  // la session serveur expire (simulée en révoquant toutes les sessions du compte)
  const v = new Vault({ get: async () => null, set: async () => {}, remove: async () => {} });
  await v.login(SERVER, 'ext', 'ext-password-123');
  await v.api.revoke();
  r = await b.bg({ type: 'sync' });
  check('reconnexion automatique après expiration de la session', !r.error, JSON.stringify(r));
  r = await b.bg({ type: 'status' });
  check('toujours déverrouillé et en ligne', r.data.unlocked && r.data.online, JSON.stringify(r.data));

  // verrouillage manuel : plus rien sur disque
  await b.bg({ type: 'lock' });
  await b.close();
  b = await launch();
  r = await b.bg({ type: 'status' });
  check('verrouillé manuellement → reste verrouillé après redémarrage', r.data.unlocked === false, JSON.stringify(r.data));

  // délai classique : rien ne survit au redémarrage
  await b.bg({ type: 'unlock', password: 'ext-password-123' });
  await b.bg({ type: 'prefs', prefs: { lock: 30 } });
  await b.close();
  b = await launch();
  r = await b.bg({ type: 'status' });
  check('avec un délai de 30 min → verrouillé au redémarrage', r.data.unlocked === false, JSON.stringify(r.data));
  await b.bg({ type: 'prefs', prefs: { lock: -1 } });
  await b.close();
} catch (e) {
  console.log('ERREUR', e.stack);
  failed = true;
}
process.exitCode = failed ? 1 : 0;
