// Test de bout en bout : node tools/test-server.mjs http://127.0.0.1:8765  (code d'inscription « famille »)
import { Vault, ApiError } from '../server/web/assets/core.js';
import assert from 'node:assert/strict';

const server = process.argv[2];
const mem = () => { const m = new Map(); return { get: async (k) => structuredClone(m.get(k)), set: async (k, v) => m.set(k, structuredClone(v)), remove: async (k) => m.delete(k) }; };
const user = 'test' + Date.now();

const a = new Vault(mem());
await assert.rejects(a.register(server, user, 'pw', 'mauvais'), /incorrect/);
await a.register(server, user, 'motdepasse-1', 'famille');
const [id1, id2] = await a.save([{ item: { name: 'GitHub', username: 'fab', password: 'x1', uris: ['github.com'] } }, { item: { name: 'Banque', password: 'x2' } }]);
assert.equal(a.list().length, 2);

// Deuxième appareil
const bs = mem();
const b = new Vault(bs);
await b.login(server, user.toUpperCase(), 'motdepasse-1');
assert.equal(b.items.get(id1).password, 'x1');

// Modification sur A, conflit sur B
await a.save([{ item: { ...a.items.get(id1), password: 'nouveau' } }]);
await assert.rejects(b.save([{ item: { ...b.items.get(id1), password: 'conflit' } }]), (e) => e.status === 409);
assert.equal(b.items.get(id1).password, 'nouveau'); // B s'est resynchronisé
await b.save([{ id: id2, del: true }]);
await a.sync();
assert.equal(a.items.has(id2), false);
assert.equal(a.cache.rev, b.cache.rev);

// Mauvais mot de passe, changement de mot de passe, révocation de la session de A
await assert.rejects(b.unlock('faux'), (e) => e.status === 401);
await b.unlock('motdepasse-1');
await b.changePassword('motdepasse-1', 'motdepasse-2');
await assert.rejects(a.sync(), (e) => e.status === 401);
await assert.rejects(a.unlock('motdepasse-1'), (e) => e.status === 401);
await a.unlock('motdepasse-2');
assert.equal(a.items.get(id1).password, 'nouveau');

// Hors-ligne : cache local seulement
const c = new Vault(bs);
await c.load();
c.api.base = 'http://127.0.0.1:1'; // serveur injoignable
await c.unlock('motdepasse-2');
assert.equal(c.online, false);
assert.equal(c.items.get(id1).password, 'nouveau');
await assert.rejects(c.save([{ id: id1, del: true }]), (e) => e instanceof ApiError && e.status === 0);
console.log('OK : tous les tests serveur passent');
