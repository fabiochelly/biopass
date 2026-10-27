// Génère tools/test-vectors.json à partir de core.js (référence pour Rust et Kotlin).
import * as core from '../server/web/assets/core.js';
import { writeFileSync } from 'node:fs';

const password = 'Crème brûlée 42!';
const salt = core.b64(Uint8Array.from({ length: 16 }, (_, i) => i));
const iter = 600000;
const { auth, wrapKey } = await core.deriveKeys(password, salt, iter);
const raw = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const wrapped = await core.wrapVaultKey(wrapKey, raw);
const vaultKey = await core.importVaultKey(raw);
const id = '0123456789abcdef0123456789abcdef';
const item = { type: 'login', name: 'Exemple', username: 'fabio', password: 'p@ss', uris: ['https://example.com'], totp: '', notes: 'é', created: 1, updated: 2 };
const enc = await core.encryptItem(vaultKey, id, item);
const t = await core.totp('JBSWY3DPEHPK3PXP', 1700000000000);
const t2 = await core.totp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&algorithm=SHA256&digits=8', 59000);
writeFileSync(new URL('./test-vectors.json', import.meta.url), JSON.stringify({
  comment: 'Généré par make-vectors.mjs. wrapped/enc sont à DÉCHIFFRER (IV aléatoire), auth doit être identique.',
  password, salt, iter, auth, vaultKeyRawB64: core.b64(raw), wrapped, itemId: id, item, itemEnc: enc,
  totp: [{ secret: 'JBSWY3DPEHPK3PXP', timeMs: 1700000000000, code: t.code },
         { secret: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&algorithm=SHA256&digits=8', timeMs: 59000, code: t2.code }],
  baseDomain: [['www.google.com', 'google.com'], ['accounts.google.co.uk', 'google.co.uk'], ['impots.gouv.fr', 'impots.gouv.fr'], ['192.168.1.1', '192.168.1.1'], ['localhost', 'localhost']]
    .map(([h, d]) => { if (core.baseDomain(h) !== d) throw new Error(h); return [h, d]; }),
}, null, 2));
console.log('auth', auth, 'totp', t.code, t2.code);
