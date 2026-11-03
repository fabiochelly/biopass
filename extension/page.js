// BioPass — monde de la page (frame principale) : intercepte navigator.credentials pour les clés d'accès
// (WebAuthn) et relaie au script de contenu, qui demande confirmation et fait signer par le service
// worker. Rien de secret ici : les options viennent de la page et la réponse lui est destinée. L'origine
// et le rpId sont revérifiés par le service worker (adresse de l'onglet fournie par le navigateur).
(() => {
  const cc = navigator.credentials;
  if (!cc || !window.PublicKeyCredential || window.top !== window) return;
  const nativeCreate = cc.create.bind(cc);
  const nativeGet = cc.get.bind(cc);
  const { btoa, atob, DOMException, Object: O } = window;

  const bytes = (v) => v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const enc = (v) => {
    let s = '';
    for (const b of bytes(v)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const dec = (s) => {
    const b = atob((s || '').replace(/-/g, '+').replace(/_/g, '/'));
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u.buffer;
  };

  // ---------------------------------------------------------------- relais vers le script de contenu

  let ready = false;
  const waiters = [];
  const replies = new Map();
  let seq = 0;
  window.addEventListener('message', (e) => {
    if (e.source !== window || typeof e.data?.bp !== 'string') return;
    if (e.data.bp === 'pk-ready') {
      ready = true;
      waiters.splice(0).forEach((f) => f(true));
    } else if (e.data.bp === 'pk-res' && replies.has(e.data.id)) {
      replies.get(e.data.id)(e.data);
      replies.delete(e.data.id);
    }
  });
  window.postMessage({ bp: 'pk-hello' }, '*'); // script de contenu déjà là (réinjection) : il répond pk-ready

  // script de contenu chargé en fin de page : on l'attend un peu, sinon le navigateur s'en charge
  const whenReady = () => ready ? true : new Promise((r) => {
    waiters.push(r);
    setTimeout(() => r(false), 5000);
  });

  async function ask(op, req, signal) {
    if (!(await whenReady())) return { native: true };
    if (signal?.aborted) return { error: 'AbortError' };
    const id = `${++seq}.${Math.random()}`;
    return new Promise((resolve) => {
      replies.set(id, resolve);
      signal?.addEventListener('abort', () => {
        if (!replies.delete(id)) return;
        window.postMessage({ bp: 'pk-abort', id }, '*');
        resolve({ error: 'AbortError' });
      }, { once: true });
      window.postMessage({ bp: 'pk-req', id, op, req }, '*');
    });
  }

  // ---------------------------------------------------------------- objets rendus à la page

  // Objets ordinaires au prototype natif (instanceof fonctionne) ; propriétés propres, qui masquent
  // les accesseurs natifs (inutilisables hors d'un vrai objet du navigateur).
  function make(proto, props) {
    const o = O.create(proto);
    for (const [k, v] of O.entries(props)) O.defineProperty(o, k, { value: v, enumerable: true });
    return o;
  }

  function credential(r, response, json, ext) {
    return make(PublicKeyCredential.prototype, {
      id: r.id, rawId: dec(r.id), type: 'public-key', authenticatorAttachment: 'platform', response,
      getClientExtensionResults: () => ext,
      toJSON: () => ({ id: r.id, rawId: r.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: ext, response: json }),
    });
  }

  function attestation(r, ext) {
    const json = {
      clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData,
      transports: r.transports, publicKey: r.publicKey, publicKeyAlgorithm: r.publicKeyAlgorithm,
    };
    const response = make(AuthenticatorAttestationResponse.prototype, {
      clientDataJSON: dec(r.clientDataJSON), attestationObject: dec(r.attestationObject),
      getTransports: () => [...r.transports], getAuthenticatorData: () => dec(r.authenticatorData),
      getPublicKey: () => dec(r.publicKey), getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
      toJSON: () => json,
    });
    return credential(r, response, json, ext);
  }

  function assertion(r) {
    const json = { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle || undefined };
    const response = make(AuthenticatorAssertionResponse.prototype, {
      clientDataJSON: dec(r.clientDataJSON), authenticatorData: dec(r.authenticatorData), signature: dec(r.signature),
      userHandle: r.userHandle ? dec(r.userHandle) : null, toJSON: () => json,
    });
    return credential(r, response, json, {});
  }

  const fail = (r) => new DOMException(r.message || 'Opération refusée', r.error);

  // ---------------------------------------------------------------- navigator.credentials

  cc.create = function create(options) {
    const pk = options?.publicKey;
    const algs = (pk?.pubKeyCredParams || []).map((p) => p.alg);
    if (!pk || (algs.length && !algs.includes(-7))) return nativeCreate(options); // ES256 seulement
    return (async () => {
      const r = await ask('create', {
        rpId: pk.rp?.id || location.hostname, rpName: pk.rp?.name || '',
        user: { id: enc(pk.user.id), name: pk.user.name || '', displayName: pk.user.displayName || '' },
        challenge: enc(pk.challenge), exclude: (pk.excludeCredentials || []).map((c) => enc(c.id)),
      }, options.signal);
      if (r.native) return nativeCreate(options);
      if (r.error) throw fail(r);
      return attestation(r.credential, pk.extensions?.credProps ? { credProps: { rk: true } } : {});
    })();
  };

  cc.get = function get(options) {
    const pk = options?.publicKey;
    if (!pk) return nativeGet(options);
    return (async () => {
      const r = await ask('get', {
        rpId: pk.rpId || location.hostname, challenge: enc(pk.challenge),
        allow: (pk.allowCredentials || []).map((c) => enc(c.id)), conditional: options.mediation === 'conditional',
      }, options.signal);
      if (r.native) return nativeGet(options);
      if (r.error) throw fail(r);
      return assertion(r.credential);
    })();
  };

  // Sites qui ne proposent les clés d'accès qu'avec un authentificateur intégré (absent sous Linux) :
  // BioPass en tient lieu.
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  PublicKeyCredential.isConditionalMediationAvailable = async () => true;
})();
