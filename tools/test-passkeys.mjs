// Clés d'accès (core.js) : attestation et signatures vérifiées par node:crypto, import Bitwarden, rpId.
//   node tools/test-passkeys.mjs
import { createPasskey, signPasskey, parseBitwarden, rpIdAllowed } from '../server/web/assets/core.js';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const u = (s) => Buffer.from(s, 'base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const { passkey, response } = await createPasskey({ rpId: 'boursobank.com', rpName: 'Bourso', user: { id: 'dXNlcg', name: 'fabio' }, challenge: 'Y2hhbA', origin: 'https://clients.boursobank.com' });
const ad = u(response.authenticatorData);
assert.deepEqual(ad.subarray(0, 32), sha('boursobank.com'));
assert.equal(ad[32], 0x5d);
assert.equal(JSON.parse(u(response.clientDataJSON)).origin, 'https://clients.boursobank.com');
// attestationObject se termine par authData
assert.ok(u(response.attestationObject).subarray(-ad.length).equals(ad));
assert.equal(u(response.attestationObject).subarray(0, 4).toString('hex'), 'a363666d');
const pub = crypto.createPublicKey({ key: u(response.publicKey), format: 'der', type: 'spki' });
const verify = async (pk) => {
  const r = await signPasskey(pk, { challenge: 'Y2hhbDI', origin: 'https://clients.boursobank.com' });
  const ok = crypto.verify('sha256', Buffer.concat([u(r.response.authenticatorData), sha(u(r.response.clientDataJSON))]), pk === passkey ? pub : crypto.createPublicKey(crypto.createPrivateKey({ key: u(pk.key), format: 'der', type: 'pkcs8' })), u(r.response.signature));
  return [ok, r];
};
for (let i = 0; i < 30; i++) assert.ok((await verify(passkey))[0], 'signature'); // DER avec/sans octet 0
// import Bitwarden
const k = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const bw = { encrypted: false, folders: [], items: [{ type: 1, name: 'Bourso', login: { username: 'fabio', password: 'x', uris: [{ uri: 'https://boursobank.com' }], fido2Credentials: [{
  credentialId: '6f1c3a2e-0b4d-4e8f-9a7b-1c2d3e4f5a6b', keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
  keyValue: k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'), rpId: 'boursobank.com', userHandle: 'AQID', userName: 'fabio', counter: '5', rpName: 'BoursoBank', userDisplayName: 'Fabio', discoverable: 'true', creationDate: '2025-01-01T00:00:00Z' }] } }] };
const [it] = parseBitwarden(JSON.stringify(bw));
assert.equal(it.passkeys.length, 1);
assert.equal(it.passkeys[0].credentialId, Buffer.from('6f1c3a2e0b4d4e8f9a7b1c2d3e4f5a6b', 'hex').toString('base64url'));
assert.ok(!it.fields.some((f) => f.name === 'Passkey'));
const [ok, r] = await verify(it.passkeys[0]);
assert.ok(ok, 'signature clé importée'); assert.equal(r.counter, 6);
assert.equal(u(r.response.authenticatorData).readUInt32BE(33), 6);
for (const [rp, url, want] of [['boursobank.com', 'https://clients.boursobank.com/x', true], ['clients.boursobank.com', 'https://clients.boursobank.com', true],
  ['com', 'https://boursobank.com', false], ['evil.com', 'https://boursobank.com', false], ['boursobank.com', 'http://boursobank.com', false], ['a.localhost', 'http://a.localhost:8766/', true]])
  assert.equal(rpIdAllowed(rp, url), want, rp + ' ' + url);
console.log('OK : clés d’accès (création, signature, import Bitwarden, rpId)');
