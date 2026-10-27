import { Vault } from '../server/web/assets/core.js';
const mem = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => m.set(k, v), remove: async (k) => m.delete(k) }; };
const v = new Vault(mem());
const S = process.argv[2] || 'http://127.0.0.1:8765';
try { await v.register(S, 'ext', 'ext-password-123', 'famille'); } catch { await v.login(S, 'ext', 'ext-password-123'); }
const del = v.list().map((it) => ({ id: it._id, del: true }));
if (del.length) await v.save(del);
await v.save([
  { item: { name: 'Site principal', username: 'alice', password: 'alice-pw', uris: ['http://site.localhost:8766'] } },
  { item: { name: 'Site (2e compte)', username: 'bob', password: 'bob-pw', uris: ['site.localhost'] } },
  { item: { name: 'Google', username: 'alice@example.com', password: 'g-pw', uris: ['https://accounts.google.localhost'], totp: 'JBSWY3DPEHPK3PXP' } },
  { item: { name: 'Auth iframe', username: 'iframe-user', password: 'iframe-pw', uris: ['http://auth.localhost:8766'] } },
  { item: { name: 'Shadow', username: 'shadow-user', password: 'shadow-pw', uris: ['shadow.localhost'] } },
  { item: { name: 'React', username: 'r@x.fr', password: 'react-pw', uris: ['react.localhost'] } },
]);
console.log('ext seeded', v.items.size);
