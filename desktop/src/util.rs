//! Recherche, domaines, TOTP et générateur — miroir des fonctions de core.js.

use hmac::{Hmac, Mac};
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

// ------------------------------------------------------------------ accès aux champs

pub fn get_str<'a>(m: &'a Map<String, Value>, k: &str) -> &'a str {
    m.get(k).and_then(Value::as_str).unwrap_or("")
}

pub fn get_bool(m: &Map<String, Value>, k: &str) -> bool {
    m.get(k).and_then(Value::as_bool).unwrap_or(false)
}

pub fn get_uris(m: &Map<String, Value>) -> Vec<&str> {
    m.get("uris")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

// ------------------------------------------------------------------ domaines

const MULTI: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "com.br",
    "com.mx", "co.za", "com.tr", "co.in", "com.cn", "com.hk", "com.sg", "co.kr", "com.ar", "gouv.fr", "asso.fr", "co.il",
];

fn has_scheme(uri: &str) -> bool {
    // équivalent de /^[a-z][a-z0-9+.-]*:/i
    let mut chars = uri.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            return false;
        }
    }
    false
}

/// Nom d'hôte (minuscules) d'une URI ; une URI sans schéma est préfixée par https://.
pub fn host_of(uri: &str) -> String {
    if uri.is_empty() {
        return String::new();
    }
    let full = if has_scheme(uri) { uri.to_string() } else { format!("https://{uri}") };
    url::Url::parse(&full)
        .ok()
        .and_then(|u| u.host_str().map(str::to_lowercase))
        .unwrap_or_default()
}

pub fn base_domain(host: &str) -> String {
    let host = host.to_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    if (!host.is_empty() && host.chars().all(|c| c.is_ascii_digit() || c == '.')) || host.contains(':') || host.starts_with('[') {
        return host.to_string();
    }
    let p: Vec<&str> = host.split('.').collect();
    if p.len() <= 2 {
        return host.to_string();
    }
    let last2 = p[p.len() - 2..].join(".");
    if MULTI.contains(&last2.as_str()) {
        p[p.len() - 3..].join(".")
    } else {
        last2
    }
}

pub fn matches_url(item: &Map<String, Value>, page_url: &str) -> bool {
    let d = base_domain(&host_of(page_url));
    !d.is_empty() && get_uris(item).iter().any(|u| base_domain(&host_of(u)) == d)
}

// ------------------------------------------------------------------ recherche

// Recherche approximative : reproduction exacte de `search` de core.js (PROTOCOL.md § 5).
// Les chaînes sont manipulées en unités UTF-16, comme les index et longueurs de JavaScript.

/// Minuscules, `œ`→`oe`, `æ`→`ae`, NFD puis suppression des diacritiques (U+0300–U+036F).
pub fn fold(s: &str) -> String {
    let lower = s.to_lowercase().replace('œ', "oe").replace('æ', "ae");
    lower.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect()
}

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Séparateur = toute unité hors `[a-z0-9]` (après fold).
fn is_sep(c: u16) -> bool {
    !((b'a' as u16..=b'z' as u16).contains(&c) || (b'0' as u16..=b'9' as u16).contains(&c))
}

/// `Math.round` de JS (demi vers +∞).
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn index_of(hay: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Distance de Damerau-Levenshtein (transpositions adjacentes), bornée à max+1.
fn edit_distance(a: &[u16], b: &[u16], max: usize) -> usize {
    if a.len().abs_diff(b.len()) > max {
        return max + 1;
    }
    let mut prev2: Option<Vec<usize>> = None;
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i];
        let mut row_min = i;
        for j in 1..=b.len() {
            let mut v = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
            if let Some(p2) = &prev2 {
                if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                    v = v.min(p2[j - 2] + 1);
                }
            }
            cur.push(v);
            row_min = row_min.min(v);
        }
        if row_min > max {
            return max + 1;
        }
        prev2 = Some(prev);
        prev = cur;
    }
    prev[b.len()]
}

/// Score d'un terme dans un champ (0 = absent), cf. `termScore`.
fn words(field: &[u16]) -> Vec<&[u16]> {
    field.split(|&c| is_sep(c)).filter(|w| !w.is_empty()).collect()
}

/// « lisapp » → début d'un mot de `a` (« lis » de lisamartin@icloud.example) + début d'un mot de `b`
/// (« app » de Apple) ; morceaux d'au moins 2 lettres, le premier pouvant être un extrait quelconque de `a`
/// s'il fait au moins 3 lettres. Miroir de `splitScore` (core.js).
pub fn split_score(t: &[u16], a: &[u16], b: &[u16]) -> u32 {
    if t.len() < 4 || a.is_empty() || b.is_empty() {
        return 0;
    }
    let (wa, wb) = (words(a), words(b));
    for k in 2..=t.len() - 2 {
        let (p1, p2) = (&t[..k], &t[k..]);
        let first = wa.iter().any(|w| w.starts_with(p1)) || (k >= 3 && index_of(a, p1).is_some());
        if first && wb.iter().any(|w| w.starts_with(p2)) {
            return 80;
        }
    }
    0
}

pub fn term_score(t: &[u16], field: &[u16]) -> u32 {
    if field.is_empty() || t.is_empty() {
        return 0;
    }
    match index_of(field, t) {
        Some(0) => return 100,
        Some(i) => return if is_sep(field[i - 1]) { 90 } else { 70 },
        None => {}
    }
    if t.len() < 3 {
        return 0;
    }
    // lettres dans l'ordre, la première en début de mot, étendue ≤ 3 × longueur
    let mut best = 0u32;
    for start in 0..field.len() {
        if field[start] != t[0] || (start > 0 && !is_sep(field[start - 1])) {
            continue;
        }
        let mut k = 1;
        let mut j = start + 1;
        while j < field.len() && k < t.len() {
            if field[j] == t[k] {
                k += 1;
            }
            j += 1;
        }
        if k == t.len() {
            let span = j - start;
            if span <= t.len() * 3 {
                let s = js_round(30.0 + (30.0 * t.len() as f64) / span as f64) as u32;
                best = best.max(s);
            }
        }
    }
    if best > 0 {
        return best;
    }
    if t.len() < 4 {
        return 0;
    }
    let max = if t.len() >= 8 { 2 } else { 1 };
    for w in field.split(|&c| is_sep(c)) {
        if w.len() < 2 {
            continue;
        }
        if edit_distance(t, w, max) <= max || (w.len() > t.len() && edit_distance(t, &w[..t.len()], max) <= max) {
            return 40;
        }
    }
    0
}

/// Champs de recherche d'une entrée (pré-calculés au déchiffrement), cf. `fuzzyFields`.
#[derive(Debug, Clone, Default)]
pub struct SearchFields {
    name: Vec<u16>,
    both: Vec<u16>,
    rev: Vec<u16>,
    host: Vec<u16>,
    username: Vec<u16>,
    folder: Vec<u16>,
    fav: bool,
}

/// Valeur « vraie » au sens de JavaScript.
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

impl SearchFields {
    pub fn new(it: &Map<String, Value>) -> SearchFields {
        let hosts: Vec<String> = get_uris(it)
            .iter()
            .map(|u| {
                let h = fold(&host_of(u));
                h.strip_prefix("www.").map(str::to_string).unwrap_or(h)
            })
            .collect();
        let name = fold(get_str(it, "name"));
        let username = fold(get_str(it, "username"));
        // « applis » → titre « Apple » + identifiant « lisa »
        let both = if username.is_empty() { String::new() } else { format!("{name} {username}") };
        // « lisapple » → identifiant « lisa » + titre « Apple »
        let rev = if username.is_empty() { String::new() } else { format!("{username} {name}") };
        SearchFields {
            name: utf16(&name),
            both: utf16(&both),
            rev: utf16(&rev),
            host: utf16(&hosts.join(" ")),
            username: utf16(&username),
            folder: utf16(&fold(get_str(it, "folder"))),
            fav: js_truthy(it.get("fav")),
        }
    }

    /// Score de l'entrée pour des termes déjà passés par `fold` (0 = exclue), cf. `searchScore`.
    pub fn score(&self, terms: &[Vec<u16>]) -> f64 {
        let fields = [(&self.name, 1.0), (&self.both, 0.9), (&self.rev, 0.9), (&self.host, 0.8), (&self.username, 0.7), (&self.folder, 0.5)];
        let mut total = 0.0;
        for t in terms {
            let mut best: f64 = 0.0;
            for (f, w) in fields {
                best = best.max(term_score(t, f) as f64 * w);
            }
            let split = split_score(t, &self.username, &self.name).max(split_score(t, &self.name, &self.username));
            best = best.max(split as f64 * 0.9);
            if best == 0.0 {
                return 0.0;
            }
            total += best;
        }
        total + if self.fav { 5.0 } else { 0.0 }
    }
}

/// `fold(q).split(/\s+/)` (blancs Unicode de JavaScript).
pub fn query_terms(query: &str) -> Vec<Vec<u16>> {
    fold(query).split(|c: char| c.is_whitespace() || c == '\u{feff}').filter(|t| !t.is_empty()).map(utf16).collect()
}

/// Requête vide : toutes les entrées, favoris d'abord ; sinon celles qui contiennent tous les termes,
/// par score décroissant puis par `fold(name)` (ordre des unités UTF-16, comme JS).
pub fn search<'a, T>(items: impl IntoIterator<Item = (&'a SearchFields, T)>, query: &str) -> Vec<T> {
    let terms = query_terms(query);
    let mut scored: Vec<(f64, &'a [u16], T)> = Vec::new();
    for (f, v) in items {
        let score = if terms.is_empty() { if f.fav { 1.0 } else { 0.0 } } else { f.score(&terms) };
        if !terms.is_empty() && score == 0.0 {
            continue;
        }
        scored.push((score, &f.name, v));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.cmp(b.1)));
    scored.into_iter().map(|s| s.2).collect()
}

// ------------------------------------------------------------------ TOTP

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Algo {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Debug, Clone)]
pub struct TotpParams {
    pub secret: String,
    pub digits: u32,
    pub period: u64,
    pub algo: Algo,
}

/// `parseInt` de JS : entier en tête de chaîne, sinon None.
fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let (neg, rest) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

pub fn parse_totp(s: &str) -> TotpParams {
    let s = s.trim();
    let mut p = TotpParams { secret: s.to_string(), digits: 6, period: 30, algo: Algo::Sha1 };
    if s.to_lowercase().starts_with("otpauth://") {
        p.secret.clear();
        if let Ok(u) = url::Url::parse(s) {
            let q = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
            p.secret = q("secret").unwrap_or_default();
            // `parseInt(x) || 6` : 0 ou invalide → valeur par défaut
            p.digits = q("digits").and_then(|v| parse_int(&v)).filter(|&n| n > 0 && n <= 10).unwrap_or(6) as u32;
            p.period = q("period").and_then(|v| parse_int(&v)).filter(|&n| n > 0).unwrap_or(30) as u64;
            p.algo = match q("algorithm").unwrap_or_default().to_uppercase().as_str() {
                "SHA256" => Algo::Sha256,
                "SHA512" => Algo::Sha512,
                _ => Algo::Sha1,
            };
        }
    }
    p
}

fn base32(s: &str) -> Option<Vec<u8>> {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = Vec::new();
    let (mut bits, mut val) = (0u32, 0u32);
    for c in s.to_uppercase().chars().filter(|c| !(c.is_whitespace() || *c == '=' || *c == '-')) {
        let i = ALPHA.iter().position(|&a| a as char == c)? as u32;
        val = (val << 5) | i;
        bits += 5;
        if bits >= 8 {
            out.push(((val >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

fn hmac_sign<M: Mac + hmac::digest::KeyInit>(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut mac = <M as hmac::digest::KeyInit>::new_from_slice(key).expect("HMAC accepte toute longueur de clé");
    mac.update(msg);
    mac.finalize().into_bytes().to_vec()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Totp {
    pub code: String,
    pub remaining: u64,
    pub period: u64,
}

/// Code TOTP à l'instant `now_ms` ; None si le secret est invalide.
pub fn totp(s: &str, now_ms: u64) -> Option<Totp> {
    let p = parse_totp(s);
    let key = base32(&p.secret)?;
    if key.is_empty() {
        return None;
    }
    let secs = now_ms / 1000;
    let counter = secs / p.period;
    let msg = counter.to_be_bytes();
    let h = match p.algo {
        Algo::Sha1 => hmac_sign::<Hmac<sha1::Sha1>>(&key, &msg),
        Algo::Sha256 => hmac_sign::<Hmac<sha2::Sha256>>(&key, &msg),
        Algo::Sha512 => hmac_sign::<Hmac<sha2::Sha512>>(&key, &msg),
    };
    let o = (h[h.len() - 1] & 15) as usize;
    let bin = ((h[o] as u64 & 127) << 24) | ((h[o + 1] as u64) << 16) | ((h[o + 2] as u64) << 8) | h[o + 3] as u64;
    let code = bin % 10u64.pow(p.digits);
    Some(Totp { code: format!("{code:0width$}", width = p.digits as usize), remaining: p.period - secs % p.period, period: p.period })
}

// ------------------------------------------------------------------ générateur

const LOWER: &str = "abcdefghijkmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS: &str = "23456789";
const SYMBOLS: &str = "!@#$%&*-_=+?.:;";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GenOptions {
    pub length: usize,
    pub lower: bool,
    pub upper: bool,
    pub digits: bool,
    pub symbols: bool,
}

impl Default for GenOptions {
    fn default() -> Self {
        GenOptions { length: 20, lower: true, upper: true, digits: true, symbols: true }
    }
}

fn rand_int(n: u32) -> u32 {
    let max = (0x1_0000_0000u64 / n as u64) * n as u64;
    loop {
        let v = u32::from_ne_bytes(crate::crypto::random_bytes::<4>());
        if (v as u64) < max {
            return v % n;
        }
    }
}

pub fn generate_password(o: &GenOptions) -> String {
    let mut sets: Vec<&str> = [(o.lower, LOWER), (o.upper, UPPER), (o.digits, DIGITS), (o.symbols, SYMBOLS)]
        .iter()
        .filter(|(on, _)| *on)
        .map(|(_, s)| *s)
        .collect();
    if sets.is_empty() {
        sets.push(LOWER);
    }
    let all: Vec<char> = sets.concat().chars().collect();
    loop {
        let pw: String = (0..o.length).map(|_| all[rand_int(all.len() as u32) as usize]).collect();
        if o.length < sets.len() || sets.iter().all(|s| pw.chars().any(|c| s.contains(c))) {
            return pw;
        }
    }
}
