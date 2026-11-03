// Vérification des sites enregistrés (action « check ») : node tools/test-check.mjs <serveur>
// Hors réseau par défaut (adresses refusées par le serveur) ; BP_NET=1 ajoute des sites réels.
import { Vault, Api } from '../server/web/assets/core.js';
import assert from 'node:assert/strict';

const server = process.argv[2];
const mem = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => m.set(k, v), remove: async (k) => m.delete(k) }; };
const v = new Vault(mem());
await v.register(server, 'check' + Date.now(), 'motdepasse-1', 'famille');
const check = (url) => v.api.call('check', { url });

// session obligatoire, adresse obligatoire
await assert.rejects(new Api(server).call('check', { url: 'https://example.com' }), (e) => e.status === 401);
await assert.rejects(check(''), (e) => e.status === 400);

// jamais de requête vers le réseau interne ni vers un port quelconque
for (const url of ['http://127.0.0.1/', 'https://localhost/', 'http://[::1]/', 'https://10.0.0.1/admin', 'androidapp://com.exemple', 'https://exemple.fr:8443/']) {
  assert.equal((await check(url)).status, 'skip', url);
}

if (process.env.BP_NET) {
  const expect = {
    'example.com': 'ok',
    'https://www.google.com/nexiste/pas-zz': 'notfound',
    'https://zz-inexistant-bp.google.com/': 'nohost',
    'https://nexistepas-biopass-zz9.com/login': 'nodomain',
    'https://nexistepas-biopass-zz9.fr/': 'nodomain',
  };
  for (const [url, status] of Object.entries(expect)) {
    const r = await check(url);
    assert.equal(r.status, status, `${url} : ${JSON.stringify(r)}`);
  }
  assert.equal((await check('https://nexistepas-biopass-zz9.com/')).rdap?.registered, false);
  console.log('OK : vérification des sites (réseau compris)');
} else {
  console.log('OK : vérification des sites (hors réseau ; BP_NET=1 pour les sites réels)');
}
