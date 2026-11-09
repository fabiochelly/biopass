// BioPass — script de contenu : détection des formulaires, menu de remplissage,
// proposition d'enregistrement. S'exécute dans un monde isolé (invisible pour la page).
(() => {
  if (window.__biopass) return;
  window.__biopass = { teardown: () => teardown() }; // réinjection après une mise à jour : cf. injectOpenTabs

  // ---------------------------------------------------------------- messagerie

  async function send(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      if (r?.error) throw new Error(r.error);
      return r?.data;
    } catch (e) {
      if (!chrome.runtime?.id) teardown(); // extension rechargée : ce script est orphelin
      throw e;
    }
  }

  // ---------------------------------------------------------------- détection des champs

  const TEXTLIKE = new Set(['', 'text', 'email', 'tel', 'number']);
  const USER_RE = /user|login|logon|signin|e-?mail|courriel|identifi|account|compte|pseudo|nick|uname|member|membre|client|customer|^id$|_id$|matricule|adherent/i;
  const NOT_USER_RE = /search|recherche|query|captcha|coupon|promo|postal|zip|city|ville|street|adresse|address|amount|montant|quantit|first.?name|last.?name|prenom|^nom$/i;
  // « Adresse e-mail », « adresse électronique », « e-mail address » : une adresse électronique, pas postale
  const EMAIL_ADDR_RE = /(?:adresse|address)\s*(?:de\s+)?(?:e-?mail|mail|[ée]lectronique|courriel)|e-?mail\s*address/g;
  const OTP_RE = /one.?time|otp|totp|2fa|mfa|two.?factor|verif|auth.?code|security.?code|code.?de.?s[ée]curit|token|pin.?code/i;
  const seenPassword = new WeakSet(); // champs mot de passe passés en clair par un bouton « afficher »

  // Champs de la page, y compris dans les composants web (shadow DOM). Trouver ces composants oblige à
  // visiter tous les éléments : coûteux sur une page lourde (Gmail, tableurs…), ce parcours n'est donc
  // refait qu'au plus une fois par seconde. Les champs eux-mêmes sont toujours relus (requêtes natives).
  let shadowRoots = [];
  let shadowScanAt = -1e9;
  function scanShadows(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.shadowRoot) {
        shadowRoots.push(n.shadowRoot);
        scanShadows(n.shadowRoot);
      }
    }
  }
  function deepInputs(near = null) {
    const root = near?.getRootNode?.();
    // champ touché dans un composant pas encore vu (apparu depuis le dernier parcours) : on reparcourt
    if (performance.now() - shadowScanAt > 1000 || (root instanceof ShadowRoot && !shadowRoots.includes(root))) {
      shadowScanAt = performance.now();
      shadowRoots = [];
      scanShadows(document);
    }
    const out = [...document.querySelectorAll('input')];
    for (const r of shadowRoots) if (r.host.isConnected) out.push(...r.querySelectorAll('input'));
    return out;
  }

  function visible(el) {
    if (!el.isConnected || el.disabled || el.type === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  }

  function labelText(el) {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) parts.push(el.getRootNode().getElementById?.(id)?.textContent || '');
    return parts.join(' ');
  }

  const desc = (el) => [el.name, el.id, el.getAttribute('autocomplete'), el.placeholder, el.getAttribute('aria-label'), labelText(el)]
    .filter(Boolean).join(' ').toLowerCase();

  function isPassword(el) {
    if (el.type === 'password') {
      seenPassword.add(el);
      return true;
    }
    return seenPassword.has(el) && el.type === 'text';
  }

  function isOtp(el) {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.includes('one-time-code')) return true;
    if (!TEXTLIKE.has(el.type) || isPassword(el)) return false;
    // champ e-mail ou déclaré identifiant : jamais un code (ForgeRock nomme ses champs « idToken1 »…)
    if (el.type === 'email' || /\b(username|email)\b/.test(ac)) return false;
    const max = el.maxLength;
    return OTP_RE.test(desc(el)) && (max <= 0 || (max >= 4 && max <= 10));
  }

  function userScore(el) {
    if (!TEXTLIKE.has(el.type) || isPassword(el) || isOtp(el)) return -1;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const d = desc(el).replace(EMAIL_ADDR_RE, ' email ');
    if (ac === 'off' && NOT_USER_RE.test(d)) return -1;
    if (NOT_USER_RE.test(d) && !USER_RE.test(d)) return -1;
    let s = 1;
    if (/\b(username|email)\b/.test(ac)) s += 10;
    if (el.type === 'email') s += 5;
    if (USER_RE.test(d)) s += 4;
    return s;
  }

  const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const formOf = (el) => el.form || el.closest('form') || null;

  // Trouve les champs à remplir autour du champ `anchor` (ou du meilleur formulaire de la page).
  function findLogin(anchor = null) {
    const inputs = deepInputs(anchor).filter(visible);
    const passwords = inputs.filter(isPassword);
    const otp = (anchor && isOtp(anchor) && anchor) || inputs.find(isOtp) || null;

    let password = anchor && isPassword(anchor) ? anchor : null;
    if (!password && anchor) {
      const f = formOf(anchor);
      password = passwords.find((p) => (f ? formOf(p) === f : true) && before(anchor, p)) || null;
    }
    if (!password && !anchor) password = passwords[0] || null;

    let username = null;
    if (anchor && userScore(anchor) > 0) username = anchor;
    else if (password) {
      const f = formOf(password);
      const cands = inputs.filter((el) => el !== password && before(el, password) && userScore(el) > 0);
      const inForm = f ? cands.filter((el) => formOf(el) === f) : [];
      const pool = inForm.length ? inForm : cands.slice(-3);
      // meilleur score ; à égalité, le plus proche du mot de passe
      username = pool.reduce((best, el) => (!best || userScore(el) >= userScore(best) ? el : best), null);
    } else if (!anchor) {
      // étape « identifiant seul » d'une connexion en deux temps
      username = inputs.filter((el) => userScore(el) >= 5).sort((a, b) => userScore(b) - userScore(a))[0] || null;
    }
    if (!password && !username && !otp) return null;
    return { username, password, otp };
  }

  function isLoginField(el) {
    if (!(el instanceof HTMLInputElement) || !visible(el)) return false;
    if (isPassword(el) || isOtp(el)) return true;
    const score = userScore(el);
    if (score <= 0) return false;
    if (score >= 5) return true; // identifiant évident : inutile de chercher un mot de passe autour
    const f = formOf(el);
    return (f ? [...f.querySelectorAll('input')] : deepInputs(el)).some((p) => p.type === 'password');
  }

  // ---------------------------------------------------------------- remplissage

  // Valeur posée par le setter natif (contourne les surcharges des frameworks, React…) + événements simulés.
  function forceValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    for (const type of ['keydown', 'keypress']) el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Unidentified' }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setValue(el, value) {
    if (!el || value == null || value === '') return;
    el.focus({ preventScroll: true });
    // D'abord une vraie saisie : execCommand produit des événements beforeinput/input « de confiance »
    // (isTrusted), traités comme une frappe au clavier par tous les sites — certains ignorent les
    // événements simulés et remettent l'ancienne valeur. Repli : setter natif (champ non éditable, maxlength…).
    let typed = false;
    if (el.ownerDocument.activeElement === el || el.getRootNode().activeElement === el) {
      try {
        el.select();
        typed = el.ownerDocument.execCommand('insertText', false, value) && el.value === value;
      } catch {}
    }
    if (!typed) forceValue(el, value);
    else {
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // valeur effacée juste après par le site (rendu asynchrone du composant) : on la repose une fois
    setTimeout(() => {
      if (el.isConnected && el.value === '') forceValue(el, value);
    }, 250);
  }

  let filling = false; // focus donné par le remplissage : ne pas rouvrir le menu

  function fill(fields, creds) {
    filling = true;
    setTimeout(() => { filling = false; }, 400);
    let done = false;
    if (fields.username && creds.username) {
      setValue(fields.username, creds.username);
      done = true;
    }
    if (fields.password && creds.password) {
      setValue(fields.password, creds.password);
      done = true;
    }
    if (fields.otp && creds.totp && !done) {
      setValue(fields.otp, creds.totp);
      done = true;
    }
    if (done) flash([fields.username, fields.password, fields.otp]);
    return done;
  }

  // Effet de remplissage « éclairage de bord » : un liseré multicolore tourne autour du contour de chaque
  // champ, avec un léger halo, puis s'éteint (en cascade d'un champ à l'autre). Dessiné PAR-DESSUS la page
  // (rien n'y est modifié) ; seule une rotation (transform) est animée : accéléré par le GPU, retiré après 1,2 s.
  function flash(els) {
    const s = ui();
    els.filter(Boolean).forEach((field, i) => {
      const r = field.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const size = Math.ceil(Math.hypot(r.width, r.height)) + 8; // carré qui tourne : couvre tout le contour
      // liseré de 1 px posé exactement sur la bordure du champ, avec le même arrondi
      const fx = el('div', 'fx', '<i class="spin"></i>');
      Object.assign(fx.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: getComputedStyle(field).borderRadius || '0' });
      fx.style.setProperty('--d', `${i * 60}ms`);
      fx.style.setProperty('--s', `${size}px`);
      s.append(fx);
      setTimeout(() => fx.remove(), 500 + i * 60);
    });
  }

  async function fillWith(id, anchor, extra = {}) {
    const fields = findLogin(anchor);
    if (!fields) return false;
    const creds = await send({ type: 'creds', id, ...extra });
    if (!creds) return false;
    const ok = fill(fields, creds);
    // champ identifiant trouvé mais entrée sans identifiant : le dire, sinon on croit à un échec du remplissage
    const noUser = ok && fields.username && !creds.username && !fields.username.value;
    if (ok && creds.totp && !fields.otp) {
      try {
        await navigator.clipboard.writeText(creds.totp);
        toast(noUser ? 'Code 2FA copié — cette entrée n\'a pas d\'identifiant' : 'Code 2FA copié dans le presse-papiers');
        return ok;
      } catch {}
    }
    if (noUser) toast('Cette entrée BioPass n\'a pas d\'identifiant');
    return ok;
  }

  // ---------------------------------------------------------------- interface (shadow DOM fermé)

  const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  const LOGO = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5-4-1.3-7-5-7-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>';
  const GO = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  const CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const USER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>';
  const KEY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/></svg>';
  const GLOBE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const PLUS = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  const PEN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    /* Animations : transform et opacity uniquement (composées par le GPU, sans recalcul de mise en page). */
    .menu, .banner, .toast {
      --bg: rgba(255,255,255,.9); --fg: #0b1220; --muted: #64748b; --line: rgba(15,23,42,.09); --hover: rgba(79,70,229,.08);
      --well: rgba(15,23,42,.035); --tint: rgba(59,130,246,.10); --solid: #fff; --hi: rgba(255,255,255,.9);
      --grad: linear-gradient(135deg, #6366f1, #3b82f6 55%, #06b6d4);
      position: fixed; color: var(--fg); background: var(--bg); border: 1px solid var(--line);
      backdrop-filter: blur(20px) saturate(1.8); -webkit-backdrop-filter: blur(20px) saturate(1.8);
      box-shadow: inset 0 1px 0 var(--hi), 0 24px 48px -12px rgba(15,23,42,.28), 0 4px 12px -2px rgba(15,23,42,.08);
      animation: pop .2s cubic-bezier(.2,.9,.3,1.15);
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .menu, .banner, .toast { --bg: rgba(20,23,31,.9); --fg: #eef0f6; --muted: #98a2b8; --line: rgba(255,255,255,.09); --hover: rgba(129,140,248,.14);
        --well: rgba(255,255,255,.04); --tint: rgba(59,130,246,.16); --solid: #2a2f3a; --hi: rgba(255,255,255,.07);
        box-shadow: inset 0 1px 0 var(--hi), 0 24px 56px -12px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.25); }
    }
    @keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(.97); } }
    /* liseré dégradé qui balaie le haut de la carte à l'ouverture */
    .menu::before, .banner::before { content: ""; position: absolute; top: -1px; left: 14px; right: 14px; height: 1px; pointer-events: none;
      background: linear-gradient(90deg, transparent, #6366f1 20%, #3b82f6 50%, #06b6d4 80%, transparent);
      transform-origin: left; animation: sweep .7s cubic-bezier(.2,.8,.2,1) .05s both; }
    @keyframes sweep { from { transform: scaleX(0); opacity: 0; } 40% { opacity: 1; } to { transform: scaleX(1); opacity: .9; } }
    .menu { min-width: 260px; max-width: 360px; border-radius: 16px; padding: 6px; font-size: 13px; transform-origin: top left; }
    .menu.up { transform-origin: bottom left; }
    .menu.still, .menu.still .item { animation: none; }
    .menu.still::before { animation: none; opacity: .9; }
    .head { display: flex; align-items: center; gap: 7px; padding: 6px 8px 7px; color: var(--muted); font-size: 12px; font-weight: 600; }
    .logo { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 6px; background: var(--grad); box-shadow: 0 2px 6px -1px rgba(79,70,229,.55); }
    .head b { color: var(--fg); font-weight: 650; letter-spacing: -.01em; }
    .keys-hint { margin-left: auto; display: flex; gap: 3px; }
    .keys-hint kbd { min-width: 18px; padding: 1px 4px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; color: var(--muted); font: 600 10px/14px system-ui, sans-serif; text-align: center; }
    .item { position: relative; display: flex; align-items: center; gap: 11px; width: 100%; padding: 7px 8px; border: 0; border-radius: 11px; background: none; color: inherit; cursor: pointer; text-align: left; font-size: 13px;
      animation: rise .26s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(var(--i, 0) * 16ms); transition: background .12s; }
    @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
    .item:hover, .item.sel { background: var(--hover); }
    .item .go { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 8px; color: #4f46e5; opacity: 0; transform: translateX(-4px); transition: opacity .14s, transform .18s cubic-bezier(.2,.8,.2,1); }
    .item:hover .go, .item.sel .go { opacity: 1; transform: none; }
    @media (prefers-color-scheme: dark) { .item .go { color: #a5b4fc; } }
    .av { flex: none; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 13px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.18), 0 1px 2px rgba(15,23,42,.12); }
    .av.site { background: none; padding: 1px; box-shadow: none; }
    .av.site canvas { width: 30px; height: 30px; border-radius: 7px; }
    .av.site.light canvas { filter: drop-shadow(0 0 1px rgba(15,23,42,.55)); }
    @media (prefers-color-scheme: dark) { .av.site.dark { background: #fff; padding: 5px; } .av.site.dark canvas { width: 22px; height: 22px; border-radius: 2px; } .av.site.light canvas { filter: none; } }
    .t { min-width: 0; flex: 1; }
    .n, .u { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .n { font-weight: 600; }
    .u { color: var(--muted); font-size: 12px; margin-top: 1px; }
    .banner { top: 16px; right: 16px; width: 340px; border-radius: 18px; padding: 16px; font-size: 14px; z-index: 2147483647; transform-origin: top right; }
    .banner .title { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 6px; }
    .banner .title svg { color: #3b82f6; }
    .banner p { margin: 0 0 14px; color: var(--muted); line-height: 1.4; word-break: break-word; }
    .banner b { color: var(--fg); font-weight: 600; }
    .banner p:empty { display: none; }
    .fields { display: grid; gap: 10px; margin: 10px 0 14px; }
    .field { display: grid; gap: 4px; min-width: 0; }
    .lbl { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    .val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .val.muted { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    .pw { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .pw .val { flex: 1; min-width: 0; }
    .eye { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer; }
    .eye:hover { background: var(--hover); color: var(--fg); }
    .x { margin-left: auto; display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer; }
    .x:hover { background: var(--hover); color: var(--fg); }
    .banner .title .x svg { color: inherit; }
    .keys { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; max-height: 232px; margin: 0 0 12px; overflow: hidden auto; }
    .pkey { display: flex; align-items: center; gap: 11px; width: 100%; padding: 10px; border: 1px solid var(--line); border-radius: 14px; background: var(--well); color: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: border-color .12s, background .12s; }
    .pkey:hover:not(:disabled) { border-color: #3b82f6; background: var(--tint); }
    .pkey:focus-visible { outline: 2px solid #3b82f6; outline-offset: 1px; }
    .pkey:disabled { opacity: .6; cursor: default; }
    .cta { flex: none; padding: 7px 12px; border-radius: 10px; background: var(--grad); color: #fff; font-size: 12.5px; font-weight: 600; box-shadow: 0 6px 16px -6px rgba(79,70,229,.65), inset 0 1px 0 rgba(255,255,255,.2); }
    .pk .title { overflow-wrap: anywhere; }
    .pk .row .btn { flex: 1; padding: 9px 14px; }
    .pk .to { margin: -6px 0 14px; }
    .pk select { color-scheme: light dark; }
    .inp { width: 100%; padding: 7px 10px; border: 1px solid var(--line); border-radius: 9px; background: transparent; color: inherit; font-size: 13px; outline: none; }
    .inp:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.18); }
    .row { display: flex; gap: 8px; justify-content: flex-end; }
    .btn { border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: var(--hover); }
    .btn.primary { background: var(--grad); border-color: transparent; color: #fff; box-shadow: 0 6px 16px -6px rgba(79,70,229,.65), inset 0 1px 0 rgba(255,255,255,.2); }
    .btn.primary:hover { filter: brightness(1.08); }
    .err { color: #ef4444; }
    .save { width: 360px; padding: 14px; border-radius: 18px; }
    .hd { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; }
    .hd .av { width: 38px; height: 38px; border-radius: 11px; font-size: 16px; }
    .hd .t { min-width: 0; flex: 1; }
    .ttl { font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
    .sub { margin-top: 2px; color: var(--muted); font-size: 12.5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .hd .x { align-self: flex-start; margin: -4px -4px 0 0; }
    .creds { border: 1px solid var(--line); border-radius: 13px; background: var(--well); overflow: hidden; }
    .cr { display: flex; align-items: center; gap: 11px; min-height: 56px; padding: 9px 8px 9px 10px; transition: background .12s; }
    .cr + .cr { border-top: 1px solid var(--line); }
    .cr:focus-within { background: var(--tint); }
    .cr .t { min-width: 0; flex: 1; }
    .cr .ic { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--tint); color: #3b82f6; }
    .cr.empty .ic { background: #3b82f6; color: #fff; }
    .cl { margin-bottom: 2px; color: var(--muted); font-size: 11.5px; font-weight: 500; }
    .cr .val { display: block; font-size: 14px; }
    .cr .mono { font-size: 13.5px; letter-spacing: .02em; }
    .cin { display: block; width: 100%; margin: 0; padding: 0; border: 0; background: none; color: inherit; font-size: 14px; outline: none; }
    .cin::placeholder { color: #3b82f6; opacity: .9; }
    .scope { display: flex; align-items: center; gap: 7px; width: 100%; margin: 0; padding: 8px 10px; border: 0; border-radius: 10px; background: none; color: var(--muted); font-size: 12.5px; text-align: left; cursor: pointer; }
    .scope:hover { background: var(--hover); }
    .scope svg { flex: none; }
    .scope b { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--fg); font-weight: 600; }
    .scope .chev { display: grid; margin-left: auto; transition: transform .15s; }
    .scope.open .chev { transform: rotate(180deg); }
    .panel { display: grid; gap: 8px; padding: 0 2px; margin-top: -4px; }
    .panel[hidden] { display: none; }
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--well); }
    .opt { padding: 6px 4px; border: 0; border-radius: 7px; background: none; color: var(--muted); font-size: 12.5px; font-weight: 600; cursor: pointer; transition: background .12s, color .12s; }
    .opt:hover { color: var(--fg); }
    .opt[aria-checked="true"] { background: var(--solid); color: var(--fg); box-shadow: 0 1px 3px rgba(15,23,42,.14), 0 0 0 1px var(--line); }
    .hint { padding: 0 2px; color: var(--muted); font-size: 12px; }
    .tabs { grid-template-columns: 1fr 1fr; margin: 0 0 12px; }
    .tabs .opt { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 6px; font-size: 13px; }
    .tabs .opt[aria-selected="true"] { background: var(--solid); color: var(--fg); box-shadow: 0 1px 3px rgba(15,23,42,.14), 0 0 0 1px var(--line); }
    .tabs .opt[aria-selected="true"] svg { color: #3b82f6; }
    .count { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--tint); color: #3b82f6; font-size: 11px; line-height: 18px; }
    .body { display: grid; gap: 10px; animation: fade .16s ease-out; }
    @keyframes fade { from { opacity: 0; transform: translateY(3px); } }
    .lead { padding: 0 2px; color: var(--muted); font-size: 12px; font-weight: 500; }
    .accts { display: grid; gap: 6px; max-height: 200px; overflow: auto; margin: -2px; padding: 2px; }
    .acct { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--well); color: inherit; font-size: 13px; text-align: left; cursor: pointer; transition: border-color .12s, background .12s, box-shadow .12s; }
    .acct:hover { background: var(--hover); }
    .acct[aria-checked="true"] { border-color: #3b82f6; background: var(--tint); box-shadow: 0 0 0 1px #3b82f6; }
    .acct .u.none { font-style: italic; }
    .tick { flex: none; display: grid; place-items: center; width: 20px; height: 20px; border: 1.5px solid var(--muted); border-radius: 50%; color: transparent; opacity: .6; transition: all .12s; }
    .acct[aria-checked="true"] .tick { border-color: #3b82f6; background: #3b82f6; color: #fff; opacity: 1; }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.primary:disabled { filter: saturate(.6); }
    .save .msg { margin: 10px 2px 0; font-size: 12.5px; }
    .save .row { margin-top: 14px; }
    .save .row .btn { flex: 1; padding: 9px 14px; }
    .fx { position: fixed; pointer-events: none; z-index: 2147483646; overflow: hidden; padding: 1px; box-sizing: border-box;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
      animation: fx-life .4s ease-out var(--d) both; }
    .fx .spin { position: absolute; left: 50%; top: 50%; width: var(--s); height: var(--s); margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
      background: conic-gradient(#ff2d55, #ff9500, #ffd60a, #34c759, #00c7be, #0a84ff, #bf5af2, #ff2d55);
      animation: fx-spin .4s cubic-bezier(.3,.1,.3,1) var(--d) both; }
    @keyframes fx-spin { from { transform: rotate(0deg); } to { transform: rotate(300deg); } }
    @keyframes fx-life { 0% { opacity: 0; } 15% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .fx .spin { animation: none; } }
    .toast { left: 50%; bottom: 24px; display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 32px); transform: translateX(-50%); border-radius: 999px; padding: 9px 18px 9px 10px; font-size: 13px; font-weight: 600; z-index: 2147483647;
      animation: toast-in .32s cubic-bezier(.2,.9,.3,1.2); }
    .toast .ok { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--grad); box-shadow: 0 3px 8px -2px rgba(79,70,229,.6); }
    @keyframes toast-in { from { opacity: 0; transform: translate(-50%, 10px) scale(.94); } }
  `;

  let host = null;
  let shadow = null;

  function ui() {
    if (host?.isConnected) return shadow;
    host = document.createElement('biopass-ui');
    host.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 auto auto 0 !important; z-index: 2147483647 !important; width: 0 !important; height: 0 !important; opacity: 1 !important; visibility: visible !important; display: block !important;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>`;
    document.documentElement.append(host);
    return shadow;
  }

  // Refuse un clic si l'interface a été masquée/altérée par la page (anti-clickjacking).
  function trusted(e) {
    if (!e.isTrusted || !host?.isConnected) return false;
    const cs = getComputedStyle(host);
    return cs.opacity === '1' && cs.visibility === 'visible' && cs.display !== 'none';
  }

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function color(str) {
    let x = 0;
    for (const c of str) x = (x * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${x % 360} 55% 45%)`;
  }

  // Icônes décodées une fois (et à l'avance, cf. prefetch) : le menu s'affiche complet dès sa première image.
  const bitmaps = new Map(); // data: URL → ImageBitmap | Promise
  function decodeIcon(icon) {
    let b = bitmaps.get(icon);
    if (!b) {
      const bytes = Uint8Array.from(atob(icon.slice(icon.indexOf(',') + 1)), (ch) => ch.charCodeAt(0));
      b = createImageBitmap(new Blob([bytes], { type: 'image/png' })).then((img) => {
        bitmaps.set(icon, img);
        return img;
      }, () => null);
      bitmaps.set(icon, b);
    }
    return b;
  }

  function avatar(name, icon, tone = '') {
    if (icon) {
      // dessin dans un canvas : une <img src="data:…"> serait bloquée par la CSP de certains sites
      const a = el('div', 'av site' + (tone ? ' ' + tone : ''));
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      a.append(c);
      const draw = (img) => {
        if (!img) return;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, 64, 64);
      };
      const b = decodeIcon(icon);
      if (b instanceof Promise) b.then(draw);
      else draw(b);
      return a;
    }
    const a = el('div', 'av');
    a.textContent = (name.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
    a.style.background = color(name);
    return a;
  }

  // ligne « libellé / valeur » des bandeaux
  function field(label, value) {
    const f = el('div', 'field');
    const l = el('span', 'lbl');
    l.textContent = label;
    f.append(l, value);
    return f;
  }

  function val(text) {
    const v = el('span', text ? 'val' : 'val muted');
    v.textContent = text || '(aucun identifiant)';
    return v;
  }

  function toast(text) {
    const s = ui();
    s.querySelector('.toast')?.remove();
    const t = el('div', 'toast', `<span class="ok">${CHECK.replace('currentColor', '#fff')}</span>`);
    t.append(text);
    s.append(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ---------------------------------------------------------------- menu sous le champ

  let menu = null;
  let menuActions = [];
  let menuAnchor = null;
  let menuSel = -1;

  function closeMenu() {
    menu?.remove();
    menu = null;
    menuAnchor = null;
    menuSel = -1;
  }

  function placeMenu() {
    if (!menu || !menuAnchor?.isConnected) return closeMenu();
    const r = menuAnchor.getBoundingClientRect();
    const h = menu.offsetHeight;
    const below = r.bottom + 6 + h < innerHeight || r.top < h + 6;
    menu.style.top = `${below ? r.bottom + 6 : r.top - h - 6}px`;
    menu.classList.toggle('up', !below);
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.minWidth = `${Math.min(Math.max(260, r.width), 360)}px`;
  }

  function showMenu(anchor, entries, title = 'BioPass') {
    const again = !!menu && menuAnchor === anchor; // même champ (filtrage pendant la frappe) : pas de nouvelle animation
    closeMenu();
    const s = ui();
    menuActions = entries.map((e) => e.action);
    menu = el('div', again ? 'menu still' : 'menu');
    menu.setAttribute('role', 'listbox');
    const head = el('div', 'head', `<span class="logo">${LOGO}</span>`);
    const name = el('b');
    name.textContent = title;
    head.append(name);
    if (entries.length > 1) head.append(el('span', 'keys-hint', '<kbd>↑</kbd><kbd>↓</kbd><kbd>↵</kbd>'));
    menu.append(head);
    entries.forEach((e, i) => {
      const b = el('button', 'item');
      b.type = 'button';
      if (i < 8) b.style.setProperty('--i', i);
      if (e.avatar) b.append(avatar(e.avatar, e.icon, e.tone));
      const t = el('div', 't');
      const n = el('div', 'n');
      n.textContent = e.name;
      t.append(n);
      if (e.sub) {
        const u = el('div', 'u');
        u.textContent = e.sub;
        t.append(u);
      }
      b.append(t, el('span', 'go', GO));
      b.addEventListener('mousedown', (ev) => ev.preventDefault()); // garder le focus sur le champ
      b.addEventListener('click', (ev) => {
        if (!trusted(ev)) return;
        closeMenu();
        e.action();
      });
      menu.append(b);
    });
    s.append(menu);
    menuAnchor = anchor;
    placeMenu();
  }

  function moveSel(delta) {
    const items = [...menu.querySelectorAll('.item')];
    if (!items.length) return;
    menuSel = (menuSel + delta + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle('sel', i === menuSel));
  }

  // État et comptes du site chargés à l'avance quand la page contient un formulaire de connexion : au focus,
  // le menu s'affiche aussitôt (sans aller-retour avec le service worker), puis est revérifié en arrière-plan.
  const LOGIN_SEL = 'input[type=password], input[autocomplete~=username], input[autocomplete~=one-time-code]';
  let warm = null;
  let warming = null;
  function prefetch() {
    if (warming || !document.querySelector(LOGIN_SEL)) return;
    warming = fetchState();
  }
  function fetchState() {
    return send({ type: 'focus' }).then((st) => {
      warm = st;
      for (const m of st?.matches || []) if (m.icon) decodeIcon(m.icon);
      return st;
    }, () => null);
  }
  const sig = (st) => st && JSON.stringify([st.configured, st.unlocked, st.inline, (st.matches || []).map((m) => [m.id, m.name, m.username, !!m.icon])]);

  function showState(field, state) {
    if (!state?.configured || !state.inline || document.activeElement !== field && field.getRootNode().activeElement !== field) return false;
    if (!state.unlocked) {
      if (!isPassword(field)) return closeMenu();
      return showMenu(field, [{ name: 'Déverrouiller BioPass', sub: 'pour remplir ce formulaire', action: () => send({ type: 'openPopup' }) }]);
    }
    menuMatches = state.matches || [];
    matchesField = field;
    renderMatches(field);
  }

  async function onFocus(e) {
    const field = e.composedPath?.()[0] || e.target;
    if (filling || !(field instanceof HTMLInputElement) || field === menuAnchor) return;
    if (!isLoginField(field)) return closeMenu();
    const shown = warm;
    if (shown) showState(field, shown);
    const state = await fetchState();
    if (!state || filling) return;
    if (!shown) showState(field, state); // premier focus avant la fin du préchargement
    else if (menuAnchor === field && sig(state) !== sig(shown)) showState(field, state); // menu encore ouvert, comptes changés
  }

  // Menu des comptes, filtré par le début de l'identifiant déjà saisi (champ identifiant).
  let menuMatches = [];
  let matchesField = null; // champ pour lequel menuMatches a été chargé
  function renderMatches(field) {
    const otpField = isOtp(field);
    let list = otpField ? menuMatches.filter((m) => m.hasTotp) : menuMatches;
    if (!otpField && !isPassword(field)) {
      const v = field.value.trim().toLowerCase();
      if (v && list.some((m) => (m.username || '').toLowerCase() === v)) return closeMenu(); // déjà rempli
      if (v) list = list.filter((m) => (m.username || '').toLowerCase().startsWith(v));
    }
    const w = pkWaiting;
    const v = field.value.trim().toLowerCase();
    const keys = otpField || !w ? [] : w.candidates.filter((c) => isPassword(field) || !v || c.userName.toLowerCase().startsWith(v));
    if (!list.length && !keys.length) return closeMenu();
    showMenu(field, [
      ...keys.map((c) => ({ name: c.name, sub: `Clé d'accès · ${c.userName}`, avatar: c.name, icon: c.icon, tone: c.tone, action: () => pkUse(w, c) })),
      ...list.filter((m) => m.hasPw || !keys.some((c) => c.itemId === m.id)).map((m) => ({ // entrée sans mot de passe : sa clé suffit
        name: otpField ? `Code 2FA — ${m.name}` : m.name,
        sub: m.username,
        avatar: m.name,
        icon: m.icon,
        tone: m.tone,
        action: () => fillWith(m.id, field),
      })),
    ]);
  }

  // ---------------------------------------------------------------- enregistrement après connexion

  // `weak` : simple clic sur un bouton de la page, peut-être sans rapport avec la connexion (cf. isRefused)
  function capture(origin, weak) {
    const scope = formOf(origin) || document;
    const inputs = (scope === document ? deepInputs() : [...scope.querySelectorAll('input')]);
    const passwords = inputs.filter((i) => isPassword(i) && i.value).map((i) => i.value);
    let username = '';
    const fields = findLogin(inputs.find((i) => isPassword(i) && i.value) || null);
    if (fields?.username?.value) username = fields.username.value.trim();
    if (!username && !passwords.length) {
      // étape 1 d'une connexion en deux temps : mémoriser l'identifiant
      const u = inputs.filter((i) => visible(i) && i.value && userScore(i) >= 5)[0];
      if (u) username = u.value.trim();
    }
    if (!username) {
      const hidden = inputs.find((i) => i.value && /username|email/.test(i.getAttribute('autocomplete') || ''));
      if (hidden) username = hidden.value.trim();
    }
    if (!passwords.length && !username) return;
    send({ type: 'captured', username, passwords, weak }).catch(() => {});
  }

  let lastCapture = 0;
  function maybeCapture(origin, weak = false) {
    if (Date.now() - lastCapture < 300) return;
    lastCapture = Date.now();
    capture(origin, weak);
  }

  async function showPending() {
    if (window !== window.top) return;
    let p;
    try {
      p = await send({ type: 'pending' });
    } catch {
      return;
    }
    if (!p) return;
    const s = ui();
    s.querySelector('.banner')?.remove();

    // deux modes : « Ajouter » (nouvelle entrée) ou « Modifier » (remplacer le mot de passe d'un compte existant du site).
    // « Modifier » d'office seulement si l'identifiant saisi correspond exactement à un compte (p.id).
    const accounts = p.accounts || [];
    let mode = p.id ? 'update' : 'add';
    let sel = p.id || (accounts.length === 1 ? accounts[0].id : null);
    let username = p.username || '';
    let match = 'domain';
    let site = p.sites?.domain ?? '';
    let scopeOpen = false;
    let shown = false;
    const pw = p.password || '';
    const masked = pw.length >= 8 ? pw.slice(0, 2) + '•'.repeat(6) + pw.slice(-2) : pw.slice(0, 1) + '•'.repeat(6);

    const b = el('div', 'banner save');
    const hd = el('div', 'hd');
    const ht = el('div', 't');
    const ttl = el('div', 'ttl');
    const sub = el('div', 'sub');
    sub.textContent = p.name;
    ht.append(ttl, sub);
    const close = el('button', 'x', CLOSE);
    close.type = 'button';
    close.title = 'Plus tard';
    hd.append(avatar(p.sites?.domain || p.name, '', ''), ht, close);
    b.append(hd);

    let tabs = [];
    if (accounts.length) {
      const bar = el('div', 'seg tabs');
      bar.setAttribute('role', 'tablist');
      tabs = [['add', PLUS, 'Ajouter'], ['update', PEN, 'Modifier']].map(([k, icon, text]) => {
        const t = el('button', 'opt', icon);
        t.type = 'button';
        t.setAttribute('role', 'tab');
        t.append(text);
        if (k === 'update') t.append(el('span', 'count', String(accounts.length)));
        t.k = k;
        t.onclick = (e) => {
          if (!trusted(e) || mode === k) return;
          mode = k;
          render();
        };
        return t;
      });
      bar.append(...tabs);
      b.append(bar);
    }

    const body = el('div', 'body');
    const text = el('p', 'msg');
    const row = el('div', 'row');
    const later = el('button', 'btn');
    later.textContent = 'Plus tard';
    const ok = el('button', 'btn primary');
    row.append(later, ok);
    b.append(body, text, row);

    const credRow = (icon, name, content) => {
      const r = el('div', 'cr');
      const t = el('div', 't');
      const l = el('div', 'cl');
      l.textContent = name;
      t.append(l, content);
      r.append(el('span', 'ic', icon), t);
      return r;
    };
    // mot de passe à demi masqué (début et fin), œil pour l'afficher en entier
    const pwRow = (name) => {
      const v = el('div', 'val mono');
      const eye = el('button', 'eye');
      eye.type = 'button';
      const paint = () => {
        v.textContent = shown ? pw : masked;
        eye.innerHTML = shown ? EYE_OFF : EYE;
        eye.title = shown ? 'Masquer' : 'Afficher';
      };
      eye.onclick = (e) => {
        if (!trusted(e)) return;
        shown = !shown;
        paint();
      };
      paint();
      const r = credRow(KEY, name, v);
      r.append(eye);
      return r;
    };
    const enter = (i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && trusted(e) && save());

    // « Ajouter » : identifiant (à saisir s'il n'a pas été détecté), mot de passe, portée repliée sous « Proposé sur … »
    function addPane() {
      const user = el('input', 'cin');
      user.value = username;
      user.placeholder = 'Ajouter un identifiant (e-mail, pseudo…)';
      user.spellcheck = false;
      user.autocomplete = 'off';
      const userRow = credRow(USER, 'Identifiant', user);
      const empty = () => userRow.classList.toggle('empty', !username.trim());
      user.addEventListener('input', () => {
        username = user.value;
        empty();
      });
      empty();
      enter(user);
      const creds = el('div', 'creds');
      creds.append(userRow, pwRow('Mot de passe'));
      body.append(creds);
      if (!p.sites) return;

      const sites = p.sites;
      const scope = el('button', 'scope', GLOBE);
      scope.type = 'button';
      const where = el('b');
      scope.append('Proposé sur', where, el('span', 'chev', CHEVRON));
      const panel = el('div', 'panel');
      const input = el('input', 'inp');
      input.spellcheck = false;
      input.autocomplete = 'off';
      const open = (v) => {
        scopeOpen = v;
        panel.hidden = !v;
        scope.classList.toggle('open', v);
      };
      scope.onclick = (e) => {
        if (!trusted(e)) return;
        open(!scopeOpen);
        if (scopeOpen) input.focus();
      };
      const seg = el('div', 'seg');
      seg.setAttribute('role', 'radiogroup');
      const hint = el('div', 'hint');
      const HINTS = {
        domain: () => `Tout ${sites.domain}, sous-domaines compris`,
        host: () => `${sites.host} et ses sous-domaines`,
        exact: () => 'Cette adresse uniquement',
      };
      const opts = [['domain', 'Domaine'], ['host', 'Hôte'], ['exact', 'URL exacte']].map(([k, label]) => {
        const o = el('button', 'opt');
        o.type = 'button';
        o.textContent = label;
        o.setAttribute('role', 'radio');
        o.k = k;
        o.onclick = (e) => {
          if (!trusted(e)) return;
          match = k;
          site = sites[k];
          paint();
        };
        return o;
      });
      seg.append(...opts);
      const paint = () => {
        input.value = site;
        where.textContent = site.trim() || '…';
        hint.textContent = HINTS[match]();
        for (const o of opts) o.setAttribute('aria-checked', String(o.k === match));
      };
      input.addEventListener('input', () => {
        site = input.value;
        where.textContent = site.trim() || '…';
      });
      enter(input);
      paint();
      open(scopeOpen);
      panel.append(seg, input, hint);
      body.append(scope, panel);
    }

    // « Modifier » : comptes du site, celui choisi reçoit le nouveau mot de passe (l'ancien va dans l'historique)
    function updatePane() {
      const lead = el('div', 'lead');
      lead.textContent = accounts.length > 1 ? 'Quel compte mettre à jour ?' : 'Compte à mettre à jour';
      const list = el('div', 'accts');
      list.setAttribute('role', 'radiogroup');
      const items = accounts.map((a) => {
        const o = el('button', 'acct');
        o.type = 'button';
        o.setAttribute('role', 'radio');
        const t = el('div', 't');
        const n = el('div', 'n');
        n.textContent = a.name;
        const u = el('div', a.username ? 'u' : 'u none');
        u.textContent = a.username || 'Sans identifiant';
        t.append(n, u);
        o.append(avatar(a.name, a.icon, a.tone), t, el('span', 'tick', CHECK));
        o.k = a.id;
        o.onclick = (e) => {
          if (!trusted(e)) return;
          sel = a.id;
          paint();
        };
        return o;
      });
      const paint = () => {
        for (const o of items) o.setAttribute('aria-checked', String(o.k === sel));
        refresh();
      };
      list.append(...items);
      const creds = el('div', 'creds');
      creds.append(pwRow('Nouveau mot de passe'));
      body.append(lead, list, creds);
      paint();
    }

    function refresh() {
      ttl.textContent = mode === 'update' ? 'Mettre à jour le mot de passe ?' : 'Enregistrer le mot de passe ?';
      ok.textContent = mode === 'update' ? 'Mettre à jour' : 'Enregistrer';
      ok.disabled = mode === 'update' && !sel;
    }

    function render() {
      body.replaceChildren();
      text.textContent = '';
      for (const t of tabs) t.setAttribute('aria-selected', String(t.k === mode));
      if (mode === 'update') updatePane();
      else addPane();
      refresh();
    }

    const dismiss = (e) => {
      if (!trusted(e)) return;
      b.remove();
      send({ type: 'dismissSave' }).catch(() => {});
    };
    later.onclick = close.onclick = dismiss;
    async function save() {
      if (ok.disabled) return;
      const update = mode === 'update';
      ok.disabled = later.disabled = true;
      ok.textContent = '…';
      try {
        await send(update ? { type: 'confirmSave', id: sel } : { type: 'confirmSave', match, uri: p.sites ? site : undefined, username });
        b.remove();
        toast(update ? 'Mot de passe mis à jour dans BioPass' : 'Enregistré dans BioPass');
      } catch (err) {
        text.textContent = err.message;
        text.className = 'msg err';
        later.disabled = false;
        refresh();
      }
    }
    ok.onclick = (e) => trusted(e) && save();

    render();
    s.append(b);
  }

  // ---------------------------------------------------------------- clés d'accès (relais de page.js)

  let pkWaiting = null; // demande « conditionnelle » : { id, req, candidates }, proposée dans le menu sous les champs
  let pkBanner = null; // { id, el } : bandeau de confirmation affiché
  const pkReply = (id, r) => window.postMessage({ bp: 'pk-res', id, ...r }, '*');
  const pkSign = (req, c) => send({ type: 'pkGet', rpId: req.rpId, challenge: req.challenge, itemId: c.itemId, credentialId: c.credentialId });

  function onPageMessage(e) {
    const d = e.data;
    if (e.source !== window || window !== window.top || typeof d?.bp !== 'string') return;
    if (d.bp === 'pk-hello') window.postMessage({ bp: 'pk-ready' }, '*');
    else if (d.bp === 'pk-abort') {
      if (pkWaiting?.id === d.id) pkWaiting = null;
      if (pkBanner?.id === d.id) {
        pkBanner.el.remove();
        pkBanner = null;
      }
    } else if (d.bp === 'pk-req') pkRequest(d).catch(() => pkReply(d.id, { native: true }));
  }

  async function pkRequest({ id, op, req }) {
    const q = await send({ type: 'pkQuery', op, ...req });
    if (q.native) return pkReply(id, { native: true });
    if (q.excluded) {
      toast('Cette clé d\'accès est déjà dans BioPass');
      return pkReply(id, { error: 'InvalidStateError', message: 'Clé d\'accès déjà enregistrée' });
    }
    if (op === 'get' && req.conditional) {
      // proposée discrètement dans le menu des champs de connexion, sans bandeau
      if (q.locked) return pkReply(id, { native: true });
      if (pkWaiting) pkReply(pkWaiting.id, { error: 'AbortError' });
      pkWaiting = { id, req, candidates: q.candidates };
      const a = document.activeElement;
      if (a instanceof HTMLInputElement && isLoginField(a)) {
        matchesField = a;
        renderMatches(a);
      }
      return;
    }
    pkPrompt(id, op, req, q);
  }

  async function pkUse(w, c) {
    if (pkWaiting !== w) return;
    try {
      const credential = await pkSign(w.req, c);
      if (pkWaiting !== w) return;
      pkWaiting = null;
      pkReply(w.id, { credential });
    } catch (err) {
      toast(err.message);
    }
  }

  // Bandeau léger, dans la page : le site, le compte, et « Autre méthode » pour laisser faire le navigateur.
  function pkPrompt(id, op, req, q) {
    const s = ui();
    s.querySelector('.banner')?.remove();
    const b = el('div', 'banner pk');
    pkBanner = { id, el: b };
    const done = (r) => {
      b.remove();
      if (pkBanner?.el === b) pkBanner = null;
      pkReply(id, r);
    };
    const title = el('div', 'title', `<span class="logo">${LOGO}</span>`);
    title.append(op === 'create' ? 'Enregistrer une clé d\'accès ?' : 'Se connecter avec une clé d\'accès');
    const close = el('button', 'x', CLOSE);
    close.title = 'Annuler';
    close.onclick = (e) => trusted(e) && done({ error: 'NotAllowedError', message: 'Annulé' });
    title.append(close);
    const body = [];
    const text = el('p');
    const failed = (err) => {
      text.textContent = err.message;
      text.className = 'err';
    };
    const row = el('div', 'row');
    const other = el('button', 'btn');
    other.textContent = 'Autre méthode';
    other.title = 'Clé de sécurité, téléphone ou gestionnaire du navigateur';
    other.onclick = (e) => trusted(e) && done({ native: true });
    row.append(other);

    if (q.locked) {
      const info = el('p');
      info.textContent = `${req.rpId} · BioPass est verrouillé.`;
      body.push(info);
      // déverrouillé (depuis la bulle ou la barre d'outils) : la demande reprend toute seule
      let watching = false;
      const watch = async () => {
        if (watching) return;
        watching = true;
        for (let i = 0; i < 300 && pkBanner?.el === b; i++) { // 5 min, sans réveiller le service worker indéfiniment
          await new Promise((r) => setTimeout(r, 1000));
          const q2 = await send({ type: 'pkQuery', op, ...req }).catch(() => null);
          if (pkBanner?.el !== b) return;
          if (!q2) break;
          if (q2.locked) continue;
          if (q2.native) return done({ native: true });
          if (q2.excluded) return done({ error: 'InvalidStateError', message: 'Clé d\'accès déjà enregistrée' });
          return pkPrompt(id, op, req, q2);
        }
        watching = false;
      };
      const unlock = el('button', 'btn primary');
      unlock.textContent = 'Déverrouiller';
      unlock.onclick = (e) => {
        if (!trusted(e)) return;
        send({ type: 'openPopup' }).catch(() => {});
        watch();
      };
      row.append(unlock);
      watch();
    } else if (op === 'create') {
      const who = req.user.name || req.user.displayName;
      const info = el('p');
      info.textContent = who ? `${req.rpId} · ${who}` : req.rpId;
      body.push(info);
      // même identifiant : la clé rejoint son entrée sans rien demander ; sinon choix en une ligne
      const name = (req.user.name || '').toLowerCase();
      let target = q.entries.find((en) => en.username.toLowerCase() === name)?.id ?? null;
      if (target === null && q.entries.length) {
        const choices = [{ id: null, name: 'Nouvelle entrée', username: '' }, ...q.entries];
        const pick = el('select', 'inp');
        for (const en of choices) pick.add(new Option(en.username ? `${en.name} · ${en.username}` : en.name));
        pick.onchange = () => { target = choices[pick.selectedIndex].id; };
        const f = field('Ajouter à', pick);
        f.classList.add('to');
        body.push(f);
      }
      const ok = el('button', 'btn primary');
      ok.textContent = 'Enregistrer';
      ok.onclick = async (e) => {
        if (!trusted(e)) return;
        ok.disabled = other.disabled = true;
        ok.textContent = '…';
        try {
          const credential = await send({ type: 'pkCreate', ...req, target });
          done({ credential });
          toast('Clé d\'accès enregistrée dans BioPass');
        } catch (err) {
          failed(err);
          ok.disabled = other.disabled = false;
          ok.textContent = 'Enregistrer';
        }
      };
      row.append(ok);
    } else {
      const info = el('p');
      info.textContent = req.rpId;
      body.push(info);
      const keys = el('div', 'keys');
      for (const c of q.candidates) {
        const k = el('button', 'pkey'); // toute la carte est cliquable, le bouton le rend évident
        k.type = 'button';
        const t = el('div', 't');
        const n = el('div', 'n');
        n.textContent = c.name;
        const u = el('div', 'u');
        u.textContent = c.userName;
        t.append(n, u);
        const go = el('span', 'cta');
        go.textContent = 'Se connecter';
        k.append(avatar(c.name, c.icon, c.tone), t, go);
        k.onclick = async (e) => {
          if (!trusted(e)) return;
          for (const x of b.querySelectorAll('button')) x.disabled = true;
          go.textContent = '…';
          try {
            done({ credential: await pkSign(req, c) });
          } catch (err) {
            failed(err);
            go.textContent = 'Se connecter';
            for (const x of b.querySelectorAll('button')) x.disabled = false;
          }
        };
        keys.append(k);
      }
      body.push(keys);
    }
    b.append(title, ...body, text, row);
    s.append(b);
  }

  // ---------------------------------------------------------------- événements

  const onKey = (e) => {
    if (menu) {
      if (e.key === 'Escape') return closeMenu();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        return moveSel(e.key === 'ArrowDown' ? 1 : -1);
      }
      if (e.key === 'Enter' && menuSel >= 0 && e.isTrusted) {
        e.preventDefault();
        e.stopPropagation();
        return closeMenuAndRun(menuSel);
      }
    }
    if (host && e.composedPath?.().includes(host)) return; // saisie dans le bandeau BioPass
    const t = e.composedPath?.()[0] || e.target;
    if (e.key === 'Enter' && t instanceof HTMLInputElement && (isPassword(t) || userScore(t) > 0)) maybeCapture(t);
  };

  function closeMenuAndRun(i) {
    const action = menuActions[i];
    closeMenu();
    action?.();
  }

  const onClick = (e) => {
    if (!e.isTrusted) return;
    const path = e.composedPath();
    if (host && path.includes(host)) return;
    if (menu && !path.includes(menuAnchor)) closeMenu();
    const btn = path.find((n) => n instanceof Element && n.matches?.('button, input[type=submit], input[type=button], [role=button], a'));
    if (btn) {
      const scope = formOf(btn) || document;
      const hasLogin = [...(scope === document ? deepInputs() : scope.querySelectorAll('input'))].some((i) => (isPassword(i) || userScore(i) >= 5) && i.value);
      if (hasLogin) maybeCapture(btn, !(btn.form && btn.type === 'submit')); // le clic précède l'événement submit
    }
  };

  const onSubmit = (e) => maybeCapture(e.target);
  // l'utilisateur tape lui-même : le menu ne doit pas masquer le bouton de connexion
  // Saisie de l'utilisateur : le menu se filtre (identifiant) ou se ferme (mot de passe : ne pas
  // masquer le bouton de connexion).
  const onInput = (e) => {
    const t = e.composedPath?.()[0] || e.target;
    if (filling || !e.isTrusted || t !== matchesField) return;
    if (isPassword(t)) return closeMenu();
    renderMatches(t); // se rouvre aussi si l'on efface jusqu'à retrouver des correspondances
  };
  const onScroll = () => placeMenu();
  const onBlur = (e) => {
    if ((e.composedPath?.()[0] || e.target) === menuAnchor) setTimeout(() => { if (document.activeElement !== menuAnchor) closeMenu(); }, 150);
  };

  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onBlur, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('input', onInput, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('message', onPageMessage);
  if (window === window.top) window.postMessage({ bp: 'pk-ready' }, '*');

  function onMessage(msg, sender, reply) {
    if (msg.type === 'autofill') {
      (async () => {
        const anchor = document.activeElement instanceof HTMLInputElement && isLoginField(document.activeElement) ? document.activeElement : null;
        const fields = findLogin(anchor);
        if (!fields) return reply(false);
        if (msg.id) return reply(await fillWith(msg.id, anchor, { nonce: msg.nonce, force: msg.force }).catch(() => false));
        const matches = await send({ type: 'matches' }).catch(() => []);
        if (matches.length === 1 || (matches.length && msg.first)) return reply(await fillWith(matches[0].id, anchor).catch(() => false));
        const target = anchor || fields.username || fields.password;
        if (matches.length > 1 && target) {
          target.focus();
          showMenu(target, matches.map((m) => ({ name: m.name, sub: m.username, avatar: m.name, action: () => fillWith(m.id, target) })));
        } else if (!matches.length && window === window.top) toast('Aucun identifiant BioPass pour ce site');
        reply(false);
      })();
      return true;
    }
    if (msg.type === 'pending') showPending();
    if (msg.type === 'toast' && window === window.top) toast(msg.text);
    if (msg.type === 'currentUser') {
      // valeur actuelle du champ identifiant de la page (null si aucun formulaire ici)
      const a = document.activeElement instanceof HTMLInputElement && isLoginField(document.activeElement) ? document.activeElement : null;
      const f = findLogin(a);
      reply(f?.username ? f.username.value : f?.password ? '' : null);
      return;
    }
    if (msg.type === 'generate') {
      const t = document.activeElement;
      if (t instanceof HTMLInputElement) {
        send({ type: 'generate' }).then((pw) => {
          // remplit le champ ciblé et sa confirmation éventuelle
          const scope = formOf(t) || document;
          const pws = [...scope.querySelectorAll('input')].filter((i) => isPassword(i) && visible(i));
          const targets = isPassword(t) ? pws.filter((p) => !before(p, t)).slice(0, 2) : [t];
          for (const f of targets.length ? targets : [t]) setValue(f, pw);
          toast('Mot de passe généré — il vous sera proposé de l\'enregistrer');
        }).catch(() => {});
      }
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function teardown() {
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('focusout', onBlur, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('submit', onSubmit, true);
    document.removeEventListener('input', onInput, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('message', onPageMessage);
    closeMenu();
    host?.remove();
    chrome.runtime.onMessage?.removeListener?.(onMessage);
    window.__biopass = null;
  }

  showPending();
  prefetch();
  // champ déjà actif au chargement (autofocus) : son focusin a eu lieu avant ce script
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && isLoginField(active)) onFocus({ target: active });
})();
