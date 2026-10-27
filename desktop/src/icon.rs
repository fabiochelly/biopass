//! Icônes des sites (champ `icon` = data URL PNG 48×48, cf. `fetchIcons` de core.js).
//! L'app de bureau ne fait que les afficher ; la récupération est faite par le site et l'extension.

use std::hash::{Hash, Hasher};
use std::io::Cursor;

use serde_json::{Map, Value};

use crate::util::{get_str, get_uris, host_of};

/// Côté maximal accepté (les icônes font 48 px ; marge pour d'autres clients).
const MAX_SIDE: u32 = 256;

/// Image RGBA 8 bits non prémultipliée.
#[derive(Debug, Clone, PartialEq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// Décode une data URL PNG (« data:image/png;base64,… »). None si absente, illisible ou trop grande.
pub fn decode_icon(data_url: &str) -> Option<Rgba> {
    let (head, b64) = data_url.split_once(',')?;
    let head = head.to_ascii_lowercase();
    if !head.starts_with("data:image/png") || !head.ends_with(";base64") {
        return None;
    }
    let bytes = crate::crypto::unb64(b64).ok()?;
    let mut dec = png::Decoder::new_with_limits(Cursor::new(bytes), png::Limits { bytes: 4 * 1024 * 1024 });
    dec.set_transformations(png::Transformations::normalize_to_color8() | png::Transformations::ALPHA);
    let mut reader = dec.read_info().ok()?;
    let (w, h) = (reader.info().width, reader.info().height);
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE {
        return None;
    }
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let buf = &buf[..info.buffer_size()];
    let n = (w * h) as usize;
    let pixels: Vec<u8> = match info.color_type {
        png::ColorType::Rgba => buf.to_vec(),
        png::ColorType::Rgb => buf.as_chunks::<3>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf.as_chunks::<2>().0.iter().flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return None, // impossible avec EXPAND
    };
    (pixels.len() == n * 4).then_some(Rgba { width: w, height: h, pixels })
}

/// Empreinte de la data URL d'une entrée (clé du cache de textures) ; None sans icône.
pub fn icon_key(item: &Map<String, Value>) -> Option<u64> {
    let s = get_str(item, "icon");
    if s.is_empty() {
        return None;
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    Some(h.finish())
}

/// Hôte dont on cherche l'icône (cf. `iconHost`) : première adresse web (ou ssh), sans « www. ».
pub fn icon_host(item: &Map<String, Value>) -> String {
    for u in get_uris(item) {
        let scheme = u.split_once(':').map(|(s, _)| s).filter(|s| {
            let mut c = s.chars();
            c.next().is_some_and(|f| f.is_ascii_alphabetic()) && c.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        });
        let ok = match scheme {
            None => true,
            Some(s) => matches!(s.to_ascii_lowercase().as_str(), "http" | "https" | "ssh"),
        };
        if ok {
            let h = host_of(u);
            let h = h.strip_prefix("www.").unwrap_or(&h);
            if !h.is_empty() && h.contains('.') && !h.chars().all(|c| c.is_ascii_digit() || c == '.') {
                return h.to_string();
            }
        }
    }
    String::new()
}

/// À l'édition : si le site change (`iconHost`), l'icône et la dernière tentative sont oubliées.
pub fn reset_icon_if_site_changed(prev: &Map<String, Value>, next: &mut Map<String, Value>) {
    if icon_host(prev) != icon_host(next) {
        next.remove("icon");
        next.remove("iconTry");
    }
}

// ------------------------------------------------------------------ catégories (cf. `entryKind`)

/// Catégorie d'une entrée sans icône de site : pictogramme sur tuile colorée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Network,
    Terminal,
    Wifi,
    Card,
    Key,
    App,
    Note,
}

/// Caractère de mot au sens de `\b` en JavaScript (sans drapeau u) : ASCII alphanumérique ou `_`.
fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `\bword\b` : `word` présent avec une frontière de mot de chaque côté.
fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + word.len()..].chars().next();
        !is_word(before) && !is_word(after)
    })
}

/// IPv4 stricte : `^\d{1,3}(\.\d{1,3}){3}$`.
fn is_ipv4(h: &str) -> bool {
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Reproduction exacte de `entryKind` (core.js).
pub fn entry_kind(it: &Map<String, Value>) -> Option<Kind> {
    use crate::util::fold;
    let uris = get_uris(it);
    let hosts: Vec<String> = uris.iter().map(|u| host_of(u)).collect();
    let text = fold(&format!("{} {}", get_str(it, "name"), get_str(it, "folder")));
    // IPv4, IPv6 (entre crochets dans une URL), localhost ou nom de réseau local
    let local_suffix = |h: &str| [".local", ".lan", ".home", ".internal", ".localdomain"].iter().any(|s| h.ends_with(s));
    if hosts.iter().any(|h| is_ipv4(h) || h.starts_with('[') || h == "localhost" || local_suffix(h)) {
        return Some(Kind::Network);
    }
    let ssh_uri = uris.iter().any(|u| u.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("ssh:")));
    if ssh_uri || has_word(&text, "ssh") || has_word(&text, "sftp") || text.contains("serveur") || has_word(&text, "vps") {
        return Some(Kind::Terminal);
    }
    if text.contains("wifi") || text.contains("wi-fi") || ["ssid", "wlan", "box"].iter().any(|w| has_word(&text, w)) {
        return Some(Kind::Wifi);
    }
    let field_names: Vec<&str> = it
        .get("fields")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|f| f.get("name").and_then(Value::as_str).unwrap_or("")).collect())
        .unwrap_or_default();
    let field_names = fold(&field_names.join(" "));
    let card_word = ["carte", "visa", "mastercard", "amex", "cb"].iter().any(|w| has_word(&text, w));
    let card_fields = field_names.contains("numero") && ["code", "cvv", "cvc", "exp"].iter().any(|w| field_names.contains(w));
    if card_word || card_fields {
        return Some(Kind::Card);
    }
    if ["api", "token", "jeton", "cle", "key", "licence", "license", "ssh-key"].iter().any(|w| has_word(&text, w)) {
        return Some(Kind::Key);
    }
    let android = |u: &&str| u.get(..11).is_some_and(|p| p.eq_ignore_ascii_case("androidapp:"));
    if !uris.is_empty() && uris.iter().all(android) {
        return Some(Kind::App);
    }
    if get_str(it, "type") == "note" || uris.is_empty() {
        return Some(Kind::Note);
    }
    None
}
