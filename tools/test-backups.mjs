// Visualiseur de sauvegardes : comparaison et restauration.
//   node tools/test-backups.mjs <url serveur avec ?k=> <dossier /biopass déployé>
import { Vault, diffVaults } from '../server/web/assets/core.js';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const [server, dir] = process.argv.slice(2);
const mem = () => { const m = new Map(); return { get: async (k) => structuredClone(m.get(k)), set: async (k, v) => m.set(k, structuredClone(v)), remove: async (k) => m.delete(k) }; };
const user = 'bk' + Date.now();
const v = new Vault(mem());
await v.register(server, user, 'motdepasse-bk', 'famille');
const [a, b] = await v.save([{ item: { name: 'Alpha', username: 'al', password: 'pw-a' } }, { item: { name: 'Bravo', password: 'pw-b' } }]);
await v.save([{ item: { name: 'Charlie' } }]);

// sauvegarde « ancienne » = état actuel figé sous une date passée
execFileSync('php', ['-r', `define('BIOPASS', 1); require '${dir}/src/lib.php';
  write_json(data_path('backups/${user}/2026-01-01.php'), ['user' => load_user('${user}'), 'vault' => load_vault('${user}')]);`]);

await v.save([{ item: { ...v.items.get(a), password: 'pw-a2' } }, { id: b, del: true }, { item: { name: 'Delta' } }]);
const list = await v.listBackups();
assert.ok(list.some((x) => x.date === '2026-01-01' && x.count === 3), JSON.stringify(list));
const snap = await v.loadBackup('2026-01-01');
let d = diffVaults(snap, v.items);
assert.deepEqual([d.added.map((i) => i.name), d.removed.map((i) => i.name), d.changed.map((c) => c.after.name + ':' + c.fields.map((f) => f.key))],
  [['Delta'], ['Bravo'], ['Alpha:password']]);

// restaurations (comme l'interface) : Bravo avec son id d'origine, Alpha à sa version d'avant
await v.save([{ item: snap.get(b) }], { touch: false });
await v.save([{ item: { ...v.items.get(a), password: snap.get(a).password } }]);
d = diffVaults(snap, v.items);
assert.deepEqual([d.added.length, d.removed.length, d.changed.length], [1, 0, 0]);
assert.equal(v.items.get(b).password, 'pw-b');

// un autre appareil resté sur une ancienne révision de Bravo ne peut pas l'écraser (conflit)
const other = new Vault(mem());
await other.login(server, user, 'motdepasse-bk');
await assert.rejects(other.api.save([{ id: b, prev: 1, del: true }]), (e) => e.status === 409);
console.log('OK : sauvegardes listées, différences exactes, restauration (même id) et conflits');
