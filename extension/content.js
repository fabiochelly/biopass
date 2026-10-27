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
    const max = el.maxLength;
    return OTP_RE.test(desc(el)) && (max <= 0 || (max >= 4 && max <= 10));
  }

  function userScore(el) {
    if (!TEXTLIKE.has(el.type) || isPassword(el) || isOtp(el)) return -1;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const d = desc(el);
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

  function setValue(el, value) {
    if (!el || value == null || value === '') return;
    el.focus({ preventScroll: true });
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    for (const type of ['keydown', 'keypress']) el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Unidentified' }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
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
    if (ok && creds.totp && !fields.otp) {
      try {
        await navigator.clipboard.writeText(creds.totp);
        toast('Code 2FA copié dans le presse-papiers');
      } catch {}
    }
    return ok;
  }

  // ---------------------------------------------------------------- interface (shadow DOM fermé)

  const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5-4-1.3-7-5-7-9.5V6z"/><circle cx="12" cy="10.5" r="2"/><path d="M12 12.5v3"/></svg>';
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .menu, .banner, .toast {
      --bg: rgba(255,255,255,.92); --fg: #0f172a; --muted: #64748b; --line: rgba(15,23,42,.08); --hover: rgba(59,130,246,.10);
      color: var(--fg); background: var(--bg); border: 1px solid var(--line);
      backdrop-filter: blur(18px) saturate(1.6); -webkit-backdrop-filter: blur(18px) saturate(1.6);
      box-shadow: 0 12px 40px rgba(15,23,42,.18), 0 2px 6px rgba(15,23,42,.08);
      animation: pop .14s ease-out;
    }
    @media (prefers-color-scheme: dark) {
      .menu, .banner, .toast { --bg: rgba(23,26,33,.92); --fg: #e5e7eb; --muted: #94a3b8; --line: rgba(255,255,255,.08); --hover: rgba(59,130,246,.18); }
    }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
    .menu { position: fixed; min-width: 260px; max-width: 360px; border-radius: 14px; padding: 6px; font-size: 13px; }
    .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px 8px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    .head svg { color: #3b82f6; }
    .item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px; border: 0; border-radius: 10px; background: none; color: inherit; cursor: pointer; text-align: left; font-size: 13px; }
    .item:hover, .item.sel { background: var(--hover); }
    .av { flex: none; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 13px; }
    .av.site { background: none; padding: 1px; }
    .av.site canvas { width: 28px; height: 28px; border-radius: 6px; }
    .av.site.light canvas { filter: drop-shadow(0 0 1px rgba(15,23,42,.55)); }
    @media (prefers-color-scheme: dark) { .av.site.dark { background: #fff; padding: 4px; } .av.site.dark canvas { width: 22px; height: 22px; border-radius: 2px; } .av.site.light canvas { filter: none; } }
    .t { min-width: 0; flex: 1; }
    .n, .u { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .n { font-weight: 600; }
    .u { color: var(--muted); font-size: 12px; margin-top: 1px; }
    .banner { position: fixed; top: 16px; right: 16px; width: 340px; border-radius: 16px; padding: 16px; font-size: 14px; z-index: 2147483647; }
    .banner .title { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 6px; }
    .banner .title svg { color: #3b82f6; }
    .banner p { margin: 0 0 14px; color: var(--muted); line-height: 1.4; word-break: break-word; }
    .banner b { color: var(--fg); font-weight: 600; }
    .row { display: flex; gap: 8px; justify-content: flex-end; }
    .btn { border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: var(--hover); }
    .btn.primary { background: linear-gradient(180deg, #3b82f6, #2563eb); border-color: #2563eb; color: #fff; }
    .btn.primary:hover { filter: brightness(1.08); }
    .err { color: #ef4444; }
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
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); border-radius: 999px; padding: 10px 18px; font-size: 13px; font-weight: 600; z-index: 2147483647; }
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

  function avatar(name, icon, tone = '') {
    if (icon) {
      // dessin dans un canvas : une <img src="data:…"> serait bloquée par la CSP de certains sites
      const a = el('div', 'av site' + (tone ? ' ' + tone : ''));
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      a.append(c);
      const bytes = Uint8Array.from(atob(icon.slice(icon.indexOf(',') + 1)), (ch) => ch.charCodeAt(0));
      createImageBitmap(new Blob([bytes], { type: 'image/png' })).then((img) => {
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, 64, 64);
      }).catch(() => {});
      return a;
    }
    const a = el('div', 'av');
    a.textContent = (name.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
    a.style.background = color(name);
    return a;
  }

  function toast(text) {
    const s = ui();
    s.querySelector('.toast')?.remove();
    const t = el('div', 'toast');
    t.textContent = text;
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
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.minWidth = `${Math.min(Math.max(260, r.width), 360)}px`;
  }

  function showMenu(anchor, entries, title = 'BioPass') {
    closeMenu();
    const s = ui();
    menuActions = entries.map((e) => e.action);
    menu = el('div', 'menu');
    menu.setAttribute('role', 'listbox');
    const head = el('div', 'head', ICON);
    head.append(title);
    menu.append(head);
    for (const e of entries) {
      const b = el('button', 'item');
      b.type = 'button';
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
      b.append(t);
      b.addEventListener('mousedown', (ev) => ev.preventDefault()); // garder le focus sur le champ
      b.addEventListener('click', (ev) => {
        if (!trusted(ev)) return;
        closeMenu();
        e.action();
      });
      menu.append(b);
    }
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

  async function onFocus(e) {
    const field = e.composedPath?.()[0] || e.target;
    if (filling || !(field instanceof HTMLInputElement) || field === menuAnchor) return;
    if (!isLoginField(field)) return closeMenu();
    let state;
    try {
      state = await send({ type: 'focus' }); // état + comptes du site en un seul aller-retour
    } catch {
      return;
    }
    if (!state?.configured || !state.inline || document.activeElement !== e.target) return;
    if (!state.unlocked) {
      if (!isPassword(field)) return;
      return showMenu(field, [{ name: 'Déverrouiller BioPass', sub: 'pour remplir ce formulaire', action: () => send({ type: 'openPopup' }) }]);
    }
    menuMatches = state.matches || [];
    matchesField = field;
    if (document.activeElement === e.target) renderMatches(field);
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
    if (!list.length) return closeMenu();
    showMenu(field, list.map((m) => ({
      name: otpField ? `Code 2FA — ${m.name}` : m.name,
      sub: m.username,
      avatar: m.name,
      icon: m.icon,
      tone: m.tone,
      action: () => fillWith(m.id, field),
    })));
  }

  // ---------------------------------------------------------------- enregistrement après connexion

  function capture(origin) {
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
    send({ type: 'captured', username, passwords }).catch(() => {});
  }

  let lastCapture = 0;
  function maybeCapture(origin) {
    if (Date.now() - lastCapture < 300) return;
    lastCapture = Date.now();
    capture(origin);
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
    const b = el('div', 'banner');
    const title = el('div', 'title', ICON);
    title.append(p.kind === 'update' ? 'Mettre à jour le mot de passe ?' : 'Enregistrer ce mot de passe ?');
    const text = el('p');
    const name = el('b');
    name.textContent = p.name;
    text.append(p.kind === 'update' ? 'Nouveau mot de passe pour ' : 'Nouvel identifiant pour ', name);
    if (p.username) text.append(` (${p.username})`);
    text.append('.');
    const row = el('div', 'row');
    const later = el('button', 'btn');
    later.textContent = 'Plus tard';
    const ok = el('button', 'btn primary');
    ok.textContent = p.kind === 'update' ? 'Mettre à jour' : 'Enregistrer';
    later.onclick = (e) => {
      if (!trusted(e)) return;
      b.remove();
      send({ type: 'dismissSave' }).catch(() => {});
    };
    ok.onclick = async (e) => {
      if (!trusted(e)) return;
      ok.disabled = later.disabled = true;
      ok.textContent = '…';
      try {
        await send({ type: 'confirmSave' });
        b.remove();
        toast('Enregistré dans BioPass');
      } catch (err) {
        text.textContent = err.message;
        text.className = 'err';
        ok.remove();
        later.disabled = false;
        later.textContent = 'Fermer';
      }
    };
    row.append(later, ok);
    b.append(title, text, row);
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
      if (hasLogin) maybeCapture(btn);
    }
  };

  const onSubmit = (e) => maybeCapture(e.target);
  // l'utilisateur tape lui-même : le menu ne doit pas masquer le bouton de connexion
  // Saisie de l'utilisateur : le menu se filtre (identifiant) ou se ferme (mot de passe : ne pas
  // masquer le bouton de connexion).
  const onInput = (e) => {
    const t = e.composedPath?.()[0] || e.target;
    if (!e.isTrusted || t !== matchesField) return;
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
    closeMenu();
    host?.remove();
    chrome.runtime.onMessage?.removeListener?.(onMessage);
    window.__biopass = null;
  }

  showPending();
})();
