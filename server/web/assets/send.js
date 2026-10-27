// BioPass — page du destinataire d'un partage (Send). Le contenu est déchiffré ici, avec la clé du
// fragment de l'URL (#…) que le serveur ne reçoit jamais.
const id = new URLSearchParams(location.search).get('s') || '';
const k = location.hash.slice(1);
const core = await import(`./index.php?f=assets/core.js&s=${encodeURIComponent(id)}`);
const { icon, hydrateIcons, avatarColor, initial } = await import(`./index.php?f=assets/icons.js&s=${encodeURIComponent(id)}`);
const api = new core.Api('.');

const $ = (sel, el = document) => el.querySelector(sel);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), v);
    else if (key === 'class') el.className = v;
    else if (key in el) el[key] = v;
    else el.setAttribute(key, v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}

function toast(msg, ok = true) {
  const t = $('#toast');
  t.replaceChildren(ok ? icon('check') : '', msg);
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

async function copy(text, label, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return toast('Copie impossible', false);
  }
  toast(`${label} copié`);
  if (btn) {
    btn.replaceChildren(icon('check'));
    setTimeout(() => btn.replaceChildren(icon('copy')), 1200);
  }
}

const iconBtn = (name, title, onclick) => h('button', { type: 'button', title, onclick }, icon(name));
const fmt = (s) => new Date(s * 1000).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

function say(text, extra) {
  $('#sub').textContent = text;
  $('#content').replaceChildren(...(extra ? [extra] : []));
}

function row(label, value, { secret = false, link = false, mono = false } = {}) {
  if (!value) return null;
  let shown = !secret;
  const v = h('div', { class: 'v' + (secret || mono ? ' mono' : '') });
  const render = () => {
    if (link && /^https?:\/\//i.test(value)) v.replaceChildren(h('a', { href: value, target: '_blank', rel: 'noopener noreferrer' }, value));
    else v.textContent = shown ? value : '•'.repeat(Math.min(value.length, 14));
  };
  render();
  const acts = h('div', { class: 'acts' });
  if (secret) {
    const eye = iconBtn('eye', 'Afficher', () => { shown = !shown; render(); eye.replaceChildren(icon(shown ? 'eyeOff' : 'eye')); });
    acts.append(eye);
  }
  const cp = iconBtn('copy', 'Copier', () => copy(value, label, cp));
  acts.append(cp);
  return h('div', { class: 'row' }, h('div', { class: 'body' }, h('div', { class: 'k' }, label), v), acts);
}

function totpRow(secret) {
  const code = h('div', { class: 'v totp-code' }, '··· ···');
  const ring = h('div', { class: 'ring' }, h('span'));
  let current = '';
  const tick = async () => {
    try {
      const t = await core.totp(secret);
      current = t.code;
      code.textContent = t.code.replace(/^(\d{3})(\d+)$/, '$1 $2');
      ring.firstChild.textContent = t.remaining;
      ring.style.setProperty('--p', t.remaining / t.period);
    } catch {
      code.textContent = 'Clé invalide';
    }
  };
  tick();
  setInterval(tick, 1000);
  const cp = iconBtn('copy', 'Copier', () => copy(current, 'Code 2FA', cp));
  return h('div', { class: 'row' }, h('div', { class: 'body' }, h('div', { class: 'k' }, 'Code 2FA'), code), ring, h('div', { class: 'acts' }, cp));
}

function avatar(name, siteIcon) {
  if (siteIcon && /^data:image\/png;base64,/.test(siteIcon)) return h('div', { class: 'avatar site' }, h('img', { src: siteIcon, alt: '' }));
  const a = h('div', { class: 'avatar' }, initial(name));
  a.style.background = avatarColor(name);
  return a;
}

function render({ payload, expires, viewsLeft }) {
  const items = payload.items || [];
  $('#sub').textContent = `${payload.from || 'Quelqu\'un'} vous partage ${items.length > 1 ? `${items.length} accès` : 'un accès'}`;
  const parts = [];
  if (payload.message) parts.push(h('div', { class: 'send-message' }, payload.message));
  for (const it of items) {
    parts.push(h('div', { class: 'send-item' },
      h('div', { class: 'send-item-head' }, avatar(it.name || '?', it.icon), h('b', {}, it.name || '(sans nom)')),
      h('div', { class: 'card' },
        row('Identifiant', it.username),
        row('Mot de passe', it.password, { secret: true }),
        it.totp ? totpRow(it.totp) : null,
        ...(it.uris || []).map((u, i) => row(i ? `Site ${i + 1}` : 'Site', u, { link: true })),
        ...(it.fields || []).map((f) => row(f.name || 'Champ', String(f.value ?? ''), { secret: f.hidden })),
        row('Notes', it.notes))));
  }
  parts.push(h('p', { class: 'hint center' }, viewsLeft === 0
    ? 'C\'était la dernière consultation : ce contenu a été effacé du serveur. Copiez maintenant ce dont vous avez besoin.'
    : `Ce partage expire le ${fmt(expires)}${viewsLeft != null ? ` et peut encore être ouvert ${viewsLeft} fois` : ''}.`));
  $('#content').replaceChildren(...parts);
}

hydrateIcons();
if (!k) {
  say('Lien incomplet : la fin du lien (après « # ») manque. Vérifiez que vous l\'avez copié en entier.');
} else {
  let info;
  try {
    info = await api.call('send_info', null, '&s=' + encodeURIComponent(id));
  } catch (e) {
    info = null;
    say(e.message);
  }
  if (info && !info.alive) say('Ce partage n\'est plus disponible : il a expiré, a déjà été consulté ou a été révoqué.');
  else if (info) {
    const err = h('p', { class: 'error', role: 'alert' });
    const pin = info.pin ? h('input', { inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: 'Code reçu séparément', maxLength: 12 }) : null;
    const btn = h('button', { type: 'submit', class: 'btn primary block' }, h('span', { class: 'label' }, 'Afficher'), h('span', { class: 'spinner' }));
    const form = h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (pin && !pin.value.trim()) return pin.focus();
      btn.disabled = true;
      btn.classList.add('busy');
      err.textContent = '';
      try {
        render(await core.openSend(api, id, k, pin ? pin.value.trim() : ''));
      } catch (ex) {
        err.textContent = ex.status === 0 ? 'Serveur injoignable' : ex.message;
        if (ex.status === 410) form.replaceChildren(err);
        pin?.select();
      } finally {
        btn.disabled = false;
        btn.classList.remove('busy');
      }
    } },
    pin && h('label', { class: 'field-in' }, h('span', {}, 'Code d\'ouverture'), pin),
    err, btn,
    h('p', { class: 'hint center' }, `Chiffré de bout en bout.${info.views_left != null ? ` Peut être ouvert ${info.views_left} fois.` : ''} Expire le ${fmt(info.expires)}.`));
    say(info.pin ? 'Un accès vous a été partagé. Saisissez le code reçu séparément.' : 'Un accès vous a été partagé.', form);
    (pin || btn).focus();
  }
}
