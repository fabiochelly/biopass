// Partie JS du test d'intégration (utilise le core.js de référence).
//   node it-js.mjs setup  <serveur> <fichier-info>   → crée un compte + une entrée
//   node it-js.mjs verify <serveur> <fichier-info>   → relit ce que Kotlin a écrit
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const core = await import(process.env.BIOPASS_CORE);
const [mode, server, infoPath] = process.argv.slice(2);
const mem = () => { const m = new Map(); return { get: async (k) => structuredClone(m.get(k)), set: async (k, v) => m.set(k, structuredClone(v)), remove: async (k) => m.delete(k) }; };

if (mode === 'setup') {
  const user = 'kt' + Date.now();
  const password = 'Crème brûlée 42!';
  const v = new core.Vault(mem());
  await v.register(server, user, password, 'famille');
  const [jsId] = await v.save([{ item: { type: 'login', name: 'Entrée JS', username: 'js', password: 'pw-js', uris: ['example.org'],
    fields: [{ name: 'PIN', value: '1234', hidden: true }], inconnu: { garde: 42 } } }]);
  writeFileSync(infoPath, JSON.stringify({ user, password, jsId }));
  console.log('JS : compte', user, 'créé, entrée', jsId);
} else {
  const info = JSON.parse(readFileSync(infoPath, 'utf8'));
  const { ktId } = JSON.parse(readFileSync(infoPath + '.kt', 'utf8'));
  const v = new core.Vault(mem());
  await v.login(server, info.user, info.password);
  const kt = v.items.get(ktId);
  assert.equal(kt.name, 'Kotlin é ✓');
  assert.equal(kt.username, 'kt');
  assert.equal(kt.password, 'pw-kt');
  assert.equal(kt.notes, 'v2');
  assert.deepEqual(kt.uris, ['androidapp://app.test', 'https://kt.example.com']);
  assert.equal(kt.folder, 'Tests');
  assert.ok(core.matchesUrl(kt, 'https://www.example.com/login'));
  const js = v.items.get(info.jsId);
  assert.equal(js.password, 'pw-modifié-par-kotlin');
  assert.deepEqual(js.inconnu, { garde: 42 });
  assert.deepEqual(js.fields, [{ name: 'PIN', value: '1234', hidden: true }]);
  assert.equal(v.list().length, 2);
  console.log('JS : entrées écrites par Kotlin relues et vérifiées');
}
