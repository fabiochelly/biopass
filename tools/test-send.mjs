// Send : partages chiffrés. node tools/test-send.mjs <url serveur avec ?k=>
import { Vault, Api, openSend, parseServer } from '../server/web/assets/core.js';
import assert from 'node:assert/strict';

const server = process.argv[2];
const { base } = parseServer(server);
const mem = () => { const m = new Map(); return { get: async (k) => structuredClone(m.get(k)), set: async (k, v) => m.set(k, structuredClone(v)), remove: async (k) => m.delete(k) }; };
const v = new Vault(mem());
await v.register(server, 'send' + Date.now(), 'motdepasse-send', 'famille');
const payload = { v: 1, from: 'fabio', message: 'Coucou', items: [{ name: 'Netflix', username: 'famille', password: 'popcorn', totp: 'JBSWY3DPEHPK3PXP' }] };
const anon = new Api(base); // destinataire : pas de clé d'accès, pas de session
const get = async (q) => (await fetch(`${base}/${q}`)).status;

// 1. partage simple, 2 consultations
const s1 = await v.createSend(payload, { title: 'Netflix', expiresIn: 3600, maxViews: 2 });
assert.equal(await get(`index.php?s=${s1.id}`), 200, 'page du partage sans clé');
assert.equal(await get(`index.php?s=${s1.id}&f=assets/send.js`), 200);
assert.equal(await get(`index.php?s=${s1.id}&f=assets/app.js`), 404, 'rien d\'autre que la page du partage');
assert.equal(await get(`index.php?s=${s1.id}&f=downloads/biopass.apk`), 404);
assert.equal(await get(`index.php?s=AAAAAAAAAAAAAAAAAAAAAA`), 404, 'identifiant inconnu → 404');
let info = await anon.call('send_info', null, '&s=' + s1.id);
assert.deepEqual([info.pin, info.alive, info.views_left], [false, true, 2]);
let r = await openSend(anon, s1.id, s1.k);
assert.deepEqual(r.payload, payload);
assert.equal(r.viewsLeft, 1);
await assert.rejects(openSend(anon, s1.id, 'AAAAAAAAAAAAAAAAAAAAAA'), (e) => e.status === 403, 'mauvaise clé');
r = await openSend(anon, s1.id, s1.k);
assert.equal(r.viewsLeft, 0);
await assert.rejects(openSend(anon, s1.id, s1.k), (e) => e.status === 410, 'consultations épuisées');
assert.equal((await anon.call('send_info', null, '&s=' + s1.id)).alive, false);

// 2. avec code : 4 codes faux tolérés, le bon fonctionne ; puis 5 faux → détruit
const s2 = await v.createSend(payload, { title: 'Netflix', expiresIn: 3600, maxViews: 0, pin: '123456' });
assert.equal((await anon.call('send_info', null, '&s=' + s2.id)).pin, true);
for (let i = 0; i < 4; i++) await assert.rejects(openSend(anon, s2.id, s2.k, '000000'), (e) => e.status === 403);
assert.deepEqual((await openSend(anon, s2.id, s2.k, '123456')).payload, payload);
await assert.rejects(openSend(anon, s2.id, s2.k, '999999'), (e) => e.status === 403 && /détruit/.test(e.message));
await assert.rejects(openSend(anon, s2.id, s2.k, '123456'), (e) => e.status === 410);

// 3. liste de l'expéditeur (titre, lien et code retrouvés), révocation
const s3 = await v.createSend(payload, { title: 'Révocable', expiresIn: 3600, maxViews: 0, pin: '654321' });
const list = await v.listSends();
const mine = list.sends.find((s) => s.id === s3.id);
assert.deepEqual([mine.title, mine.k, mine.pin, mine.alive], ['Révocable', s3.k, '654321', true]);
assert.equal(list.sends.length, 3);
await v.deleteSend(s3.id);
assert.equal(await get(`index.php?s=${s3.id}`), 404, 'révoqué → 404');
// un autre utilisateur ne voit pas ces partages
const other = new Vault(mem());
await other.register(server, 'other' + Date.now(), 'motdepasse-o', 'famille');
assert.equal((await other.listSends()).sends.length, 0);
await assert.rejects(other.deleteSend(s1.id), (e) => e.status === 404);
// sans clé d'accès, les autres actions restent un 404
assert.equal((await fetch(`${base}/api.php?a=send_list`)).status, 404);
console.log('OK : Send (lien, code, consultations, destruction, révocation, isolation, accès sans clé limité)');
