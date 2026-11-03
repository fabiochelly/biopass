#!/usr/bin/env node
// BioPass — pont pour un lanceur de bureau (préfixe « pwd » de fabio.launcher, par exemple).
//
// Processus de courte durée : le lanceur le démarre en entrant dans son mode, lui parle en JSON (une ligne
// par message sur stdin/stdout) et l'arrête en se refermant. Le coffre, la synchronisation et la recherche
// approximative sont ceux de core.js.
//
// Ce qui sort sur stdout : noms et identifiants, jamais un mot de passe. Pour copier, le lanceur envoie un
// id et ce processus passe la valeur à wl-copy par stdin (donc jamais sur une ligne de commande, visible
// par `ps`). Elle est marquée sensible pour rester hors de l'historique du presse-papiers, qui n'est
// jamais vidé ensuite.
//
// Sur disque, dans ~/.config/biopass-launcher (0700) : `server` (adresse, avec sa clé d'accès), le profil et
// le cache, tous deux chiffrés comme ceux de l'extension. La clé du coffre, elle, reste dans le trousseau
// du bureau (secret-tool) jusqu'à la commande `lock`.
//
//   → {op:"search",q} | {op:"copy",id,field:"password"|"username"} | {op:"unlock",user?,password} | {op:"lock"}
//   ← {t:"state",state:"setup"|"locked"|"ready",user,online,count} | {t:"rows",q,rows:[{id,name,username,hasPw,icon,tone,initial,hue}]}
//     {t:"copied",field,name} | {t:"unlockFailed",message} | {t:"error",message}
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Vault, hostOf, search } from '../extension/lib/core.js';
import { avatarColor, initial } from '../extension/lib/icons.js';

const DIR = process.env.BIOPASS_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'biopass-launcher');
const SECRET = ['app', 'biopass-launcher'];
const MAX_ROWS = 12; // chaque ligne porte son icône : la réponse doit rester légère à chaque frappe

const file = (k) => join(DIR, `${k}.json`);
const storage = {
  async get(k) {
    try {
      return JSON.parse(await readFile(file(k), 'utf8'));
    } catch {
      return null;
    }
  },
  async set(k, v) {
    await mkdir(DIR, { recursive: true, mode: 0o700 });
    const tmp = `${file(k)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(v), { mode: 0o600 });
    await rename(tmp, file(k)); // jamais de cache à moitié écrit
  },
  remove: (k) => rm(file(k), { force: true }),
};

function run(cmd, args, input = '') {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ code: -1, out: '' }));
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

const secrets = {
  async load() {
    const r = await run('secret-tool', ['lookup', ...SECRET]);
    try {
      return r.code === 0 ? JSON.parse(r.out) : null;
    } catch {
      return null;
    }
  },
  async save() {
    const s = JSON.stringify({ raw: vault.rawKey, token: vault.api.token, auth: vault.auth });
    const r = await run('secret-tool', ['store', '--label=BioPass (lanceur)', ...SECRET], s);
    if (r.code !== 0) throw new Error('Trousseau du bureau indisponible');
  },
  clear: () => run('secret-tool', ['clear', ...SECRET]),
};

const vault = new Vault(storage, { keepRaw: true });
let query = '';

const say = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const logins = () => vault.list().filter((it) => (it.type || 'login') === 'login' && (it.password || it.username));

function sayState() {
  const state = vault.unlocked ? 'ready' : vault.profile ? 'locked' : 'setup';
  say({ t: 'state', state, user: vault.profile?.user || '', online: vault.online, count: vault.unlocked ? logins().length : 0 });
}

function sayRows() {
  const rows = search(logins(), query).slice(0, MAX_ROWS).map((it) => {
    const name = it.name || hostOf(it.uris?.[0]) || '(sans nom)';
    return {
      id: it._id, name, username: it.username || '', hasPw: !!it.password,
      icon: it.icon ? `data:image/png;base64,${it.icon.slice(it.icon.indexOf(',') + 1)}` : '',
      tone: it.iconTone || '', initial: initial(name), hue: Number(avatarColor(name).match(/hsl\((\d+)/)[1]),
    };
  });
  say({ t: 'rows', q: query, rows });
}

// Le cache répond tout de suite ; le serveur complète ensuite, s'il est joignable. Token expiré : nouvelle
// session sans mot de passe. Si elle est refusée, le mot de passe maître a changé : il faut le ressaisir.
async function refresh() {
  try {
    const before = vault.api.token;
    if (!before) await vault.relogin();
    let changed;
    try {
      changed = await vault.sync();
    } catch (e) {
      if (e.status !== 401 || !(await vault.relogin())) throw e;
      changed = await vault.sync();
    }
    if (!vault.unlocked) return; // verrouillé pendant la synchronisation : rien à réenregistrer
    if (vault.api.token !== before) await secrets.save();
    if (changed && vault.unlocked) sayRows();
  } catch (e) {
    if (e.status === 401) {
      await lock();
      say({ t: 'unlockFailed', message: 'Mot de passe maître changé : à ressaisir' });
    } else if (e.status !== 0) {
      say({ t: 'error', message: e.message });
    }
    return;
  }
  sayState();
}

async function lock() {
  vault.lock();
  await secrets.clear();
  sayState();
}

async function unlock({ user, password }) {
  try {
    if (vault.profile) {
      await vault.unlock(password);
    } else {
      const server = (await readFile(join(DIR, 'server'), 'utf8').catch(() => '')).trim();
      if (!server) return say({ t: 'unlockFailed', message: `Adresse du serveur absente : ${join(DIR, 'server')}` });
      await vault.login(server, user || '', password);
    }
    await secrets.save();
  } catch (e) {
    vault.lock();
    const wrong = e.name === 'OperationError' || e.status === 401 || e.status === 403;
    return say({ t: 'unlockFailed', message: wrong ? 'Mot de passe incorrect' : e.message });
  }
  sayState();
  sayRows();
}

async function copy({ id, field }) {
  const it = vault.items.get(id);
  const value = field === 'password' ? it?.password : it?.username;
  if (!value) return say({ t: 'error', message: 'Rien à copier' });
  const r = await run('wl-copy', ['--sensitive'], value);
  if (r.code !== 0) return say({ t: 'error', message: 'Copie impossible (wl-copy)' });
  say({ t: 'copied', field, name: it.name || '' });
}

async function handle(m) {
  if (m.op === 'search') {
    query = String(m.q || '');
    if (vault.unlocked) sayRows();
  } else if (m.op === 'copy') await copy(m);
  else if (m.op === 'unlock') await unlock(m);
  else if (m.op === 'lock') await lock();
}

await mkdir(DIR, { recursive: true, mode: 0o700 });
await vault.load();
const saved = vault.profile && await secrets.load();
if (saved?.raw) await vault.resume(saved.raw, saved.token, saved.auth);
sayState();
if (vault.unlocked) {
  sayRows();
  refresh();
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  handle(m).catch((e) => say({ t: 'error', message: e.message }));
});
lines.on('close', () => process.exit(0)); // lanceur disparu : le coffre déchiffré ne reste pas en mémoire
