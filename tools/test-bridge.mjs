#!/usr/bin/env node
// Test du pont des lanceurs (launcher-bridge.mjs) contre un vrai serveur : node tools/test-bridge.mjs <serveur>
// secret-tool et wl-copy sont remplacés par des scripts : ni le trousseau ni le presse-papiers ne sont touchés.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Vault } from '../extension/lib/core.js';

const SERVER = process.argv[2];
const BRIDGE = new URL('./launcher-bridge.mjs', import.meta.url).pathname;
const USER = `pont${Date.now()}`;
const MASTER = 'pont-Maitre-2026!';
const SECRET_PW = 'Gh-Secret-Tres-2026';
const ICON = 'iVBORw0KGgo=';

const T = mkdtempSync(join(tmpdir(), 'biopass-bridge-'));
const DIR = join(T, 'conf');
const script = (name, body) => {
  writeFileSync(join(T, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(T, name), 0o755);
};
script('secret-tool', `case "$1" in store) cat > "${T}/secret" ;; lookup) cat "${T}/secret" 2>/dev/null ;; clear) rm -f "${T}/secret" ;; esac`);
script('wl-copy', `printf '%s' "$*" > "${T}/args"; cat > "${T}/clip"`);
const env = { ...process.env, PATH: `${T}:${process.env.PATH}`, BIOPASS_DIR: DIR };

let ok = 0;
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log('  ✓', name); } else { console.log('  ✗', name, extra); process.exitCode = 1; }
};

let seen = ''; // tout ce que le lanceur a reçu
function start() {
  const p = spawn(process.execPath, [BRIDGE], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const queue = [];
  const waiters = [];
  createInterface({ input: p.stdout }).on('line', (line) => {
    seen += `${line}\n`;
    const m = JSON.parse(line);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  });
  const wait = (pred, ms = 8000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('pas de réponse du pont')), ms).unref();
    });
  };
  return {
    send: (m) => p.stdin.write(`${JSON.stringify(m)}\n`),
    wait,
    state: (s) => wait((m) => m.t === 'state' && m.state === s),
    rows: (q) => wait((m) => m.t === 'rows' && m.q === q),
    stop: () => new Promise((r) => { p.once('close', r); p.stdin.end(); }),
  };
}

// Le compte et ses entrées, créés par un client ordinaire
const mem = new Map();
const client = new Vault({ get: async (k) => mem.get(k), set: async (k, v) => mem.set(k, v), remove: async (k) => mem.delete(k) });
await client.register(SERVER, USER, MASTER, 'famille');
await client.save([
  { item: { type: 'login', name: 'GitHub', username: 'dave@example.net', password: SECRET_PW, uris: ['https://github.com/login'], icon: `data:image/png;base64,${ICON}`, iconTone: 'dark' } },
  { item: { type: 'login', name: 'Sans mot de passe', username: 'seul@example.net' } },
  { item: { type: 'note', name: 'Note privée', notes: 'rien' } },
]);
await client.sync();

try {
  let b = start();
  await b.state('setup');
  b.send({ op: 'unlock', user: USER, password: MASTER });
  check('sans adresse de serveur : message clair', (await b.wait((m) => m.t === 'unlockFailed')).message.includes('Adresse du serveur'));
  writeFileSync(join(DIR, 'server'), SERVER);

  b.send({ op: 'unlock', user: USER, password: 'mauvais' });
  check('mauvais mot de passe refusé', (await b.wait((m) => m.t === 'unlockFailed')).message === 'Mot de passe incorrect');
  check('rien dans le trousseau', !existsSync(join(T, 'secret')));
  b.send({ op: 'unlock', user: USER, password: MASTER });
  const ready = await b.state('ready');
  check('déverrouillé : deux entrées (la note est écartée)', ready.count === 2 && ready.online && ready.user === USER, JSON.stringify(ready));

  b.send({ op: 'search', q: 'gthub' });
  const rows = (await b.rows('gthub')).rows;
  check('recherche approximative', rows[0]?.name === 'GitHub' && rows[0].username === 'dave@example.net' && rows[0].hasPw, JSON.stringify(rows));
  check('icône : image du coffre, sinon initiale et teinte', rows[0].icon === `data:image/png;base64,${ICON}` && rows[0].tone === 'dark'
    && rows[0].initial === 'G' && Number.isInteger(rows[0].hue), JSON.stringify(rows[0]));
  b.send({ op: 'search', q: 'note' });
  check('la note reste hors de la liste', (await b.rows('note')).rows.length === 0);

  b.send({ op: 'copy', id: rows[0].id, field: 'password' });
  check('copie annoncée sans la valeur', (await b.wait((m) => m.t === 'copied')).field === 'password');
  check('mot de passe copié tel quel, par stdin', readFileSync(join(T, 'clip'), 'utf8') === SECRET_PW);
  check('marqué sensible, et rien sur la ligne de commande', readFileSync(join(T, 'args'), 'utf8') === '--sensitive');
  b.send({ op: 'copy', id: rows[0].id, field: 'username' });
  await b.wait((m) => m.t === 'copied' && m.field === 'username');
  check('identifiant copié', readFileSync(join(T, 'clip'), 'utf8') === 'dave@example.net');
  await b.stop();

  check('cache et profil en 0600', ['vault', 'profile'].every((k) => (statSync(join(DIR, `${k}.json`)).mode & 0o777) === 0o600));
  check('dossier en 0700', (statSync(DIR).mode & 0o777) === 0o700);
  check('aucun secret en clair sur le disque', !`${readFileSync(join(DIR, 'vault.json'))}${readFileSync(join(DIR, 'profile.json'))}`.includes(SECRET_PW));

  // Réouverture : sans mot de passe, et une entrée créée ailleurs arrive par la synchronisation
  await client.save([{ item: { type: 'login', name: 'Ajoutée ailleurs', username: 'x', password: 'y-2026' } }]);
  b = start();
  await b.state('ready');
  check('réouverture sans mot de passe, liste du cache avant le réseau', !(await b.wait((m) => m.t === 'rows')).rows.some((r) => r.name === 'Ajoutée ailleurs'));
  check('entrée distante reçue ensuite', (await b.wait((m) => m.t === 'rows')).rows.some((r) => r.name === 'Ajoutée ailleurs'));
  await b.state('ready');
  await b.stop();

  // Token expiré : nouvelle session sans mot de passe
  const s = JSON.parse(readFileSync(join(T, 'secret'), 'utf8'));
  writeFileSync(join(T, 'secret'), JSON.stringify({ ...s, token: 'expire' }));
  b = start();
  await b.state('ready');
  await b.state('ready'); // après la synchronisation
  // Le token ne dépend que de l'heure à la seconde près : il peut être égal à l'ancien, mais plus à « expire »
  check('token expiré : nouvelle session enregistrée', /\./.test(JSON.parse(readFileSync(join(T, 'secret'), 'utf8')).token));
  await b.stop();

  // Serveur injoignable : lecture du cache
  const profile = JSON.parse(readFileSync(join(DIR, 'profile.json'), 'utf8'));
  writeFileSync(join(DIR, 'profile.json'), JSON.stringify({ ...profile, server: 'http://127.0.0.1:9/' }));
  b = start();
  await b.state('ready');
  b.send({ op: 'search', q: 'github' });
  check('hors ligne : recherche dans le cache', (await b.rows('github')).rows.length === 1);
  await b.stop();
  writeFileSync(join(DIR, 'profile.json'), JSON.stringify(profile));

  // Verrouillage
  b = start();
  await b.state('ready');
  b.send({ op: 'lock' });
  await b.state('locked');
  check('verrouillé : trousseau vidé', !existsSync(join(T, 'secret')));
  await b.stop();
  b = start();
  await b.state('locked');
  b.send({ op: 'search', q: 'github' });
  await b.stop();
  check('toujours verrouillé à la réouverture', true);

  check('aucun mot de passe vu par le lanceur', !seen.includes(SECRET_PW) && !seen.includes(MASTER) && !seen.includes('y-2026'));
  console.log(`  ${ok} vérifications`);
} catch (e) {
  console.log('  ✗', e.message);
  process.exitCode = 1;
} finally {
  rmSync(T, { recursive: true, force: true });
}
process.exit(process.exitCode || 0);
