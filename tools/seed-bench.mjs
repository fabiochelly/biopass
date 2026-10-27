// Coffre réaliste pour tools/bench-extension.mjs : 800 entrées, ~250 sites, icônes PNG 128 px (~5-10 Ko,
// comme celles produites par iconFromBlob), notes, dossiers, quelques codes 2FA.
//   node tools/seed-bench.mjs <serveur> [nombre]
import { Vault, ICON_VERSION } from '../server/web/assets/core.js';
import { deflateSync, crc32 } from 'node:zlib';

const S = process.argv[2] || 'http://127.0.0.1:8765';
const N = +(process.argv[3] || 800);

// PNG RGBA minimal : disque coloré anti-crénelé + barre (logo plausible, compressé comme un vrai)
function png(seed) {
  const W = 128;
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const [r, g, b] = [rnd() * 255, rnd() * 255, rnd() * 255].map(Math.round);
  const raw = Buffer.alloc((W * 4 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let i = 0; i < W; i++) {
      const d = Math.hypot(i - 63.5, y - 63.5);
      const a = Math.max(0, Math.min(1, 60 - d));
      const bar = Math.abs(i - 64) < 10 && Math.abs(y - 64) < 36 ? 1 : 0;
      const o = y * (W * 4 + 1) + 1 + i * 4;
      const n = () => (rnd() < 0.12 ? Math.round(rnd() * 4 - 2) : 0); // léger grain : poids proche des vraies icônes (~9 Ko)
      raw[o] = bar ? 255 : Math.max(0, Math.min(255, r + n()));
      raw[o + 1] = bar ? 255 : Math.max(0, Math.min(255, Math.round(g * (0.7 + 0.3 * y / W)) + n()));
      raw[o + 2] = bar ? 255 : Math.max(0, Math.min(255, b + n()));
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const words = ['banque', 'mail', 'cloud', 'shop', 'store', 'travel', 'news', 'music', 'video', 'jeux', 'sport', 'santé', 'impots', 'assur',
  'energie', 'mobile', 'box', 'dev', 'git', 'forum', 'photo', 'drive', 'agenda', 'compta', 'crm', 'vpn', 'ssh', 'nas', 'routeur', 'école'];
const folders = ['', '', 'Finances', 'Administratif', 'Dev', 'Maison', 'Loisirs', 'Travail'];
const people = ['alice', 'bob', 'claire', 'david', 'emma', 'famille'];
const sites = Array.from({ length: 250 }, (_, i) => `${words[i % words.length]}${i}.example.com`);
const icons = new Map(sites.map((s, i) => [s, png(i + 1)]));

const mem = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => m.set(k, v), remove: async (k) => m.delete(k) }; };
const v = new Vault(mem());
try { await v.register(S, 'ext', 'ext-password-123', 'famille'); } catch { await v.login(S, 'ext', 'ext-password-123'); }
const del = v.list().map((it) => ({ id: it._id, del: true }));
for (let i = 0; i < del.length; i += 200) await v.save(del.slice(i, i + 200));
const items = Array.from({ length: N }, (_, i) => {
  const site = sites[i % sites.length];
  const who = people[i % people.length];
  return {
    type: 'login',
    name: `${site.split('.')[0].replace(/\d+$/, (n) => ' ' + n)} ${who}`.replace(/^./, (c) => c.toUpperCase()),
    username: `${who}${i}@example.net`,
    password: `pw-${i}-${'x'.repeat(16)}`,
    uris: [`https://${site}/login`],
    folder: folders[i % folders.length] || undefined,
    notes: i % 5 ? '' : 'Note : ' + 'lorem ipsum '.repeat(10),
    totp: i % 9 ? '' : 'JBSWY3DPEHPK3PXP',
    fav: i % 37 === 0,
    icon: icons.get(site),
    iconV: ICON_VERSION,
  };
});
// les sites de test de l'extension, pour mesurer le remplissage
items.push({ type: 'login', name: 'Site principal', username: 'alice', password: 'alice-pw', uris: ['http://site.localhost:8766'] },
  { type: 'login', name: 'Site (2e compte)', username: 'bob', password: 'bob-pw', uris: ['site.localhost'] });
for (let i = 0; i < items.length; i += 50) await v.save(items.slice(i, i + 50).map((item) => ({ item })));
const bytes = items.reduce((n, it) => n + (it.icon?.length || 0), 0);
console.log(`coffre de banc : ${v.items.size} entrées, icônes ${(bytes / 1e6).toFixed(1)} Mo (${Math.round(bytes / N / 1024)} Ko/entrée)`);
