//! Thème BioPass : palette sombre / claire, style egui, polices système, icônes et logo dessinés.

use std::f32::consts::{PI, TAU};
use std::sync::Arc;

use biopass::icon::Kind as EntryKind;

use eframe::egui::{
    self, epaint, pos2, vec2, Align2, Color32, Context, CornerRadius, FontData, FontDefinitions, FontFamily, FontId,
    Margin, Mesh, Painter, Pos2, Rect, Response, Sense, Shadow, Shape, Stroke, StrokeKind, Theme, Ui, Vec2, Widget,
};

// ------------------------------------------------------------------ palette

#[derive(Clone, Copy)]
pub struct Pal {
    pub dark: bool,
    pub bg: Color32,
    pub panel: Color32,
    pub card: Color32,
    pub hover: Color32,
    pub input: Color32,
    pub border: Color32,
    pub text: Color32,
    pub muted: Color32,
    pub accent: Color32,
    pub accent_hi: Color32,
    pub accent_lo: Color32,
    pub on_accent: Color32,
    pub danger: Color32,
    pub success: Color32,
    pub warn: Color32,
}

const fn hex(rgb: u32) -> Color32 {
    Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}

pub const DARK: Pal = Pal {
    dark: true,
    bg: hex(0x0f1115),
    panel: hex(0x171a21),
    card: hex(0x1d212a),
    hover: hex(0x252a35),
    input: hex(0x12151b),
    border: hex(0x2a303c),
    text: hex(0xe5e7eb),
    muted: hex(0x9ca3af),
    accent: hex(0x3b82f6),
    accent_hi: hex(0x60a5fa),
    accent_lo: hex(0x2563eb),
    on_accent: hex(0xffffff),
    danger: hex(0xf87171),
    success: hex(0x34d399),
    warn: hex(0xfbbf24),
};

pub const LIGHT: Pal = Pal {
    dark: false,
    bg: hex(0xf3f4f6),
    panel: hex(0xffffff),
    card: hex(0xf8fafc),
    hover: hex(0xeef2f7),
    input: hex(0xffffff),
    border: hex(0xe2e8f0),
    text: hex(0x111827),
    muted: hex(0x6b7280),
    accent: hex(0x2563eb),
    accent_hi: hex(0x3b82f6),
    accent_lo: hex(0x1d4ed8),
    on_accent: hex(0xffffff),
    danger: hex(0xdc2626),
    success: hex(0x059669),
    warn: hex(0xd97706),
};

pub fn pal(ctx: &Context) -> Pal {
    match ctx.theme() {
        Theme::Dark => DARK,
        Theme::Light => LIGHT,
    }
}

pub fn alpha(c: Color32, a: f32) -> Color32 {
    c.gamma_multiply(a)
}

/// Mélange opaque de `a` vers `b` (t = 0 → a, t = 1 → b).
pub fn mix(a: Color32, b: Color32, t: f32) -> Color32 {
    let l = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t).round() as u8;
    Color32::from_rgb(l(a.r(), b.r()), l(a.g(), b.g()), l(a.b(), b.b()))
}

// ------------------------------------------------------------------ polices

pub const SEMIBOLD: &str = "semibold";

pub fn semibold(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name(SEMIBOLD.into()))
}

pub fn regular(size: f32) -> FontId {
    FontId::proportional(size)
}

/// Police système (sans rien embarquer) : (fichier, index régulier, fichier, index semi-gras).
fn system_fonts() -> Option<(Arc<FontData>, Option<Arc<FontData>>)> {
    let candidates: &[(&str, u32, &str, u32)] = &[
        // Linux
        ("/usr/share/fonts/inter/Inter.ttc", 0, "/usr/share/fonts/inter/Inter.ttc", 12),
        ("/usr/share/fonts/opentype/inter/Inter-Regular.otf", 0, "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf", 0),
        ("/usr/share/fonts/noto/NotoSans-Regular.ttf", 0, "/usr/share/fonts/noto/NotoSans-SemiBold.ttf", 0),
        ("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", 0, "/usr/share/fonts/truetype/noto/NotoSans-SemiBold.ttf", 0),
        ("/usr/share/fonts/google-noto/NotoSans-Regular.ttf", 0, "/usr/share/fonts/google-noto/NotoSans-SemiBold.ttf", 0),
        ("/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf", 0, "/usr/share/fonts/truetype/ubuntu/Ubuntu-M.ttf", 0),
        ("/usr/share/fonts/TTF/DejaVuSans.ttf", 0, "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", 0),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0, "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
        // Windows
        ("C:\\Windows\\Fonts\\segoeui.ttf", 0, "C:\\Windows\\Fonts\\seguisb.ttf", 0),
        // macOS
        ("/System/Library/Fonts/SFNS.ttf", 0, "/System/Library/Fonts/SFNS.ttf", 0),
        ("/System/Library/Fonts/Helvetica.ttc", 0, "/System/Library/Fonts/Helvetica.ttc", 1),
    ];
    for (reg, ri, bold, bi) in candidates {
        let Ok(bytes) = std::fs::read(reg) else { continue };
        let blob: epaint::text::Blob = Arc::new(bytes);
        let regular = Arc::new(FontData::from_blob(blob.clone(), *ri));
        let bold = if bold == reg {
            Some(Arc::new(FontData::from_blob(blob, *bi)))
        } else {
            std::fs::read(bold).ok().map(|b| Arc::new(FontData::from_blob(Arc::new(b), *bi)))
        };
        return Some((regular, bold));
    }
    None
}

pub fn install_fonts(ctx: &Context) {
    let mut fonts = FontDefinitions::default();
    let mut prop = fonts.families.get(&FontFamily::Proportional).cloned().unwrap_or_default();
    let mut bold_family = prop.clone();
    if let Some((reg, bold)) = system_fonts() {
        fonts.font_data.insert("sys-regular".into(), reg);
        prop.insert(0, "sys-regular".into());
        bold_family = prop.clone();
        if let Some(b) = bold {
            fonts.font_data.insert("sys-semibold".into(), b);
            bold_family.insert(0, "sys-semibold".into());
        }
    }
    fonts.families.insert(FontFamily::Proportional, prop);
    fonts.families.insert(FontFamily::Name(SEMIBOLD.into()), bold_family);
    ctx.set_fonts(fonts);
}

// ------------------------------------------------------------------ style

fn style_for(p: &Pal, base: &egui::Style) -> egui::Style {
    use egui::{TextStyle, Visuals};
    let mut s = base.clone();
    s.text_styles = [
        (TextStyle::Small, regular(12.0)),
        (TextStyle::Body, regular(14.5)),
        (TextStyle::Button, regular(14.0)),
        (TextStyle::Heading, semibold(22.0)),
        (TextStyle::Monospace, FontId::monospace(14.0)),
    ]
    .into();
    let sp = &mut s.spacing;
    sp.item_spacing = vec2(8.0, 8.0);
    sp.button_padding = vec2(12.0, 7.0);
    sp.interact_size = vec2(40.0, 30.0);
    sp.window_margin = Margin::same(20);
    sp.menu_margin = Margin::same(8);
    sp.icon_width = 18.0;
    sp.icon_width_inner = 10.0;
    sp.icon_spacing = 8.0;
    sp.slider_rail_height = 6.0;
    sp.scroll.bar_width = 6.0;
    sp.scroll.floating = true;

    let mut v = if p.dark { Visuals::dark() } else { Visuals::light() };
    let r8 = CornerRadius::same(8);
    v.override_text_color = Some(p.text);
    v.weak_text_color = Some(p.muted);
    v.hyperlink_color = p.accent_hi;
    v.faint_bg_color = p.card;
    v.extreme_bg_color = p.input;
    v.text_edit_bg_color = Some(p.input);
    v.code_bg_color = p.card;
    v.panel_fill = p.panel;
    v.window_fill = p.panel;
    v.window_stroke = Stroke::new(1.0, p.border);
    v.window_corner_radius = CornerRadius::same(14);
    v.menu_corner_radius = CornerRadius::same(10);
    v.window_shadow = Shadow { offset: [0, 12], blur: 36, spread: 0, color: Color32::from_black_alpha(if p.dark { 140 } else { 40 }) };
    v.popup_shadow = Shadow { offset: [0, 6], blur: 18, spread: 0, color: Color32::from_black_alpha(if p.dark { 110 } else { 30 }) };
    v.error_fg_color = p.danger;
    v.warn_fg_color = p.warn;
    v.selection.bg_fill = alpha(p.accent, 0.35);
    v.selection.stroke = Stroke::new(1.0, p.accent_hi);
    v.text_cursor.stroke = Stroke::new(2.0, p.accent_hi);
    v.slider_trailing_fill = true;
    v.striped = false;
    v.indent_has_left_vline = false;

    let w = &mut v.widgets;
    w.noninteractive.bg_fill = p.panel;
    w.noninteractive.weak_bg_fill = p.panel;
    w.noninteractive.bg_stroke = Stroke::new(1.0, p.border);
    w.noninteractive.fg_stroke = Stroke::new(1.0, p.text);
    w.noninteractive.corner_radius = r8;

    w.inactive.bg_fill = p.card;
    w.inactive.weak_bg_fill = p.card;
    w.inactive.bg_stroke = Stroke::new(1.0, p.border);
    w.inactive.fg_stroke = Stroke::new(1.0, p.text);
    w.inactive.corner_radius = r8;

    w.hovered.bg_fill = p.hover;
    w.hovered.weak_bg_fill = p.hover;
    w.hovered.bg_stroke = Stroke::new(1.0, alpha(p.accent, 0.6));
    w.hovered.fg_stroke = Stroke::new(1.5, p.text);
    w.hovered.corner_radius = r8;
    w.hovered.expansion = 0.0;

    w.active.bg_fill = p.hover;
    w.active.weak_bg_fill = p.hover;
    w.active.bg_stroke = Stroke::new(1.5, p.accent);
    w.active.fg_stroke = Stroke::new(1.5, p.text);
    w.active.corner_radius = r8;
    w.active.expansion = 0.0;

    w.open = w.active;
    s.visuals = v;
    s
}

pub fn install(ctx: &Context) {
    install_fonts(ctx);
    let base = egui::Style::default();
    ctx.set_style_of(Theme::Dark, style_for(&DARK, &base));
    ctx.set_style_of(Theme::Light, style_for(&LIGHT, &base));
    ctx.set_theme(egui::ThemePreference::System);
}

// ------------------------------------------------------------------ avatars

/// Couleur stable dérivée du nom.
pub fn name_color(name: &str) -> Color32 {
    let mut h: u32 = 2166136261;
    for b in name.to_lowercase().bytes() {
        h = (h ^ b as u32).wrapping_mul(16777619);
    }
    let hue = (h % 360) as f32 / 360.0;
    egui::ecolor::Hsva::new(hue, 0.62, 0.42, 1.0).into()
}

/// Initiale : premier caractère alphanumérique, en majuscule (cf. `initial` d'icons.js).
pub fn initial(name: &str) -> String {
    name.chars().find(|c| c.is_alphanumeric()).map(|c| c.to_uppercase().collect()).unwrap_or_else(|| "?".into())
}

fn avatar_radius(rect: Rect) -> CornerRadius {
    CornerRadius::same((rect.width() * 0.3).round() as u8)
}

/// Liseré intérieur discret des tuiles colorées (cf. `.avatar` : inset 1px blanc à 15 %).
fn inset_edge(painter: &Painter, rect: Rect) {
    painter.rect_stroke(rect, avatar_radius(rect), Stroke::new(1.0, Color32::from_white_alpha(38)), StrokeKind::Inside);
}

pub fn paint_avatar(painter: &Painter, rect: Rect, name: &str) {
    painter.rect_filled(rect, avatar_radius(rect), name_color(name));
    inset_edge(painter, rect);
    painter.text(rect.center(), Align2::CENTER_CENTER, initial(name), semibold(rect.height() * 0.44), Color32::WHITE);
}

pub fn avatar(ui: &mut Ui, size: f32, name: &str) -> Response {
    avatar_icon(ui, size, name, None, None)
}

// ------------------------------------------------------------------ icônes de catégorie

/// Dégradé à 135° de `KIND_COLORS` (icons.js).
pub fn kind_colors(k: EntryKind) -> (Color32, Color32) {
    match k {
        EntryKind::Network => (hex(0x0ea5e9), hex(0x0369a1)),
        EntryKind::Terminal => (hex(0x475569), hex(0x0f172a)),
        EntryKind::Wifi => (hex(0x22c55e), hex(0x0f766e)),
        EntryKind::Card => (hex(0xf59e0b), hex(0xb45309)),
        EntryKind::Key => (hex(0xa855f7), hex(0x6d28d9)),
        EntryKind::App => (hex(0x10b981), hex(0x047857)),
        EntryKind::Note => (hex(0xfacc15), hex(0xca8a04)),
    }
}

/// Contour d'un rectangle arrondi (sens horaire), pour les maillages.
fn rounded_rect_points(rect: Rect, r: f32) -> Vec<Pos2> {
    let r = r.min(rect.width() / 2.0).min(rect.height() / 2.0);
    let corners = [
        (pos2(rect.right() - r, rect.top() + r), -PI / 2.0),
        (pos2(rect.right() - r, rect.bottom() - r), 0.0),
        (pos2(rect.left() + r, rect.bottom() - r), PI / 2.0),
        (pos2(rect.left() + r, rect.top() + r), PI),
    ];
    corners.iter().flat_map(|&(c, a0)| arc(c, r, a0, a0 + PI / 2.0, 6)).collect()
}

/// Tuile arrondie au dégradé diagonal (haut-gauche → bas-droite).
fn paint_gradient_tile(painter: &Painter, rect: Rect, c1: Color32, c2: Color32) {
    let pts = rounded_rect_points(rect, rect.width() * 0.3);
    let col = |p: Pos2| {
        let t = ((p.x - rect.left()) + (p.y - rect.top())) / (rect.width() + rect.height());
        mix(c1, c2, t.clamp(0.0, 1.0))
    };
    let mut mesh = Mesh::default();
    mesh.colored_vertex(rect.center(), col(rect.center()));
    for p in &pts {
        mesh.colored_vertex(*p, col(*p));
    }
    let n = pts.len() as u32;
    for i in 0..n {
        mesh.add_triangle(0, 1 + i, 1 + (i + 1) % n);
    }
    painter.add(Shape::mesh(mesh));
}

/// Pictogramme de catégorie (chemins SVG 24×24 d'icons.js, trait 1,9, extrémités rondes).
pub fn paint_kind_glyph(p: &Painter, rect: Rect, kind: EntryKind, color: Color32) {
    let s = rect.width() / 24.0;
    let at = |x: f32, y: f32| rect.min + vec2(x * s, y * s);
    let w = (1.9 * s).max(1.1);
    let st = Stroke::new(w, color);
    let cap = |q: Pos2| p.circle_filled(q, w / 2.0, color);
    let pl = |pts: Vec<Pos2>| {
        cap(pts[0]);
        cap(pts[pts.len() - 1]);
        p.add(Shape::line(pts, st));
    };
    let dot = |x: f32, y: f32| p.circle_filled(at(x, y), w * 0.6, color);
    let rrect = |x: f32, y: f32, ww: f32, hh: f32, r: f32| {
        let rc = Rect::from_min_size(at(x, y), vec2(ww * s, hh * s));
        p.add(Shape::closed_line(rounded_rect_points(rc, r * s), st));
    };
    // arc de cercle passant au-dessus, de (x0, y) à (x1, y), de rayon r (commande SVG « a r r 0 0 1 »)
    let arc_over = |x0: f32, x1: f32, y: f32, r: f32| {
        let half = (x1 - x0) / 2.0;
        let c = at((x0 + x1) / 2.0, y + (r * r - half * half).max(0.0).sqrt());
        let a = (half / r).clamp(-1.0, 1.0).asin();
        pl(arc(c, r * s, -PI / 2.0 - a, -PI / 2.0 + a, 16));
    };
    match kind {
        EntryKind::Key => {
            p.circle_stroke(at(7.5, 15.5), 4.5 * s, st);
            pl(vec![at(10.7, 12.3), at(20.0, 3.0)]);
            pl(vec![at(17.0, 6.0), at(20.0, 9.0)]);
            pl(vec![at(14.0, 9.0), at(16.0, 11.0)]);
        }
        EntryKind::Note => {
            let mut outline = vec![at(14.0, 3.0)];
            outline.extend(arc(at(6.0, 5.0), 2.0 * s, -PI / 2.0, -PI, 4));
            outline.extend(arc(at(6.0, 19.0), 2.0 * s, PI, PI / 2.0, 4));
            outline.extend(arc(at(18.0, 19.0), 2.0 * s, PI / 2.0, 0.0, 4));
            outline.push(at(20.0, 9.0));
            p.add(Shape::closed_line(outline, st));
            pl(vec![at(14.0, 3.0), at(14.0, 9.0), at(20.0, 9.0)]);
            pl(vec![at(8.0, 13.0), at(16.0, 13.0)]);
            pl(vec![at(8.0, 17.0), at(13.0, 17.0)]);
        }
        EntryKind::Network => {
            rrect(3.0, 14.0, 18.0, 6.0, 2.0);
            dot(7.0, 17.0);
            dot(11.0, 17.0);
            pl(vec![at(12.0, 14.0), at(12.0, 11.0)]);
            arc_over(8.5, 15.5, 8.5, 5.0);
            arc_over(6.0, 18.0, 6.0, 8.5);
        }
        EntryKind::Terminal => {
            rrect(2.5, 4.0, 19.0, 16.0, 3.0);
            pl(vec![at(7.0, 9.0), at(10.0, 12.0), at(7.0, 15.0)]);
            pl(vec![at(13.0, 15.0), at(17.0, 15.0)]);
        }
        EntryKind::Wifi => {
            arc_over(5.0, 19.0, 12.5, 10.0);
            arc_over(8.5, 15.5, 16.0, 5.0);
            arc_over(2.0, 22.0, 9.0, 14.5);
            dot(12.0, 19.5);
        }
        EntryKind::Card => {
            rrect(2.5, 5.0, 19.0, 14.0, 3.0);
            pl(vec![at(2.5, 10.0), at(21.5, 10.0)]);
            pl(vec![at(6.5, 15.0), at(10.5, 15.0)]);
        }
        EntryKind::App => {
            rrect(6.0, 2.0, 12.0, 20.0, 2.5);
            pl(vec![at(11.0, 18.0), at(13.0, 18.0)]);
            pl(vec![at(9.0, 6.0), at(15.0, 6.0)]);
        }
    }
}

pub fn paint_kind_avatar(painter: &Painter, rect: Rect, kind: EntryKind) {
    let (c1, c2) = kind_colors(kind);
    paint_gradient_tile(painter, rect, c1, c2);
    inset_edge(painter, rect);
    paint_kind_glyph(painter, Rect::from_center_size(rect.center(), rect.size() * 0.58), kind, Color32::WHITE);
}

// ------------------------------------------------------------------ icônes de sites

/// Textures d'une icône de site : l'image et sa silhouette blanche (pour le contour).
#[derive(Clone)]
pub struct SiteIcon {
    pub img: egui::TextureHandle,
    pub mask: egui::TextureHandle,
}

/// Icône brute, sans fond, coins légèrement arrondis. `tone` (`iconTone`) : « dark » → pastille blanche en
/// thème sombre ; « light » → contour sombre en thème clair (cf. `.avatar.site` de style.css).
pub fn paint_site_icon(ui: &Ui, rect: Rect, icon: &SiteIcon, tone: &str, dark: bool) {
    if tone == "dark" && dark {
        ui.painter().rect_filled(rect, CornerRadius::same((rect.width() * 0.3).round() as u8), Color32::WHITE);
        let inner = rect.shrink(rect.width() / 8.0);
        egui::Image::from_texture((icon.img.id(), inner.size())).corner_radius(2).paint_at(ui, inner);
        return;
    }
    let inner = rect.shrink((rect.width() / 20.0).max(1.0));
    let r = CornerRadius::same((inner.width() * 0.15).round() as u8);
    let outline = (tone == "light" && !dark).then(|| Color32::from_rgba_unmultiplied(15, 23, 42, 140));
    if let Some(c) = outline {
        let size = inner.size();
        for (dx, dy) in [(-1.0, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0), (-0.7, -0.7), (0.7, -0.7), (-0.7, 0.7), (0.7, 0.7)] {
            egui::Image::from_texture((icon.mask.id(), size))
                .tint(c)
                .corner_radius(r)
                .paint_at(ui, inner.translate(vec2(dx, dy)));
        }
    }
    egui::Image::from_texture((icon.img.id(), inner.size())).corner_radius(r).paint_at(ui, inner);
}

/// Avatar d'une entrée : icône du site, sinon pictogramme de catégorie, sinon initiale colorée.
pub fn paint_item_avatar(ui: &Ui, rect: Rect, name: &str, kind: Option<EntryKind>, site: Option<(&SiteIcon, &str)>) {
    let dark = pal(ui.ctx()).dark;
    match (site, kind) {
        (Some((icon, tone)), _) => paint_site_icon(ui, rect, icon, tone, dark),
        (None, Some(k)) => paint_kind_avatar(ui.painter(), rect, k),
        (None, None) => paint_avatar(ui.painter(), rect, name),
    }
}

pub fn avatar_icon(ui: &mut Ui, size: f32, name: &str, kind: Option<EntryKind>, site: Option<(&SiteIcon, &str)>) -> Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    paint_item_avatar(ui, rect, name, kind, site);
    resp
}

// ------------------------------------------------------------------ logo

/// Contour du bouclier dans le carré unité (0..1).
fn shield_points() -> Vec<Pos2> {
    let bez = |p0: Pos2, p1: Pos2, p2: Pos2, p3: Pos2, n: usize| -> Vec<Pos2> {
        (0..=n)
            .map(|i| {
                let t = i as f32 / n as f32;
                let u = 1.0 - t;
                let x = u * u * u * p0.x + 3.0 * u * u * t * p1.x + 3.0 * u * t * t * p2.x + t * t * t * p3.x;
                let y = u * u * u * p0.y + 3.0 * u * u * t * p1.y + 3.0 * u * t * t * p2.y + t * t * t * p3.y;
                pos2(x, y)
            })
            .collect()
    };
    let mut right = vec![pos2(0.5, 0.04)];
    right.extend(bez(pos2(0.5, 0.04), pos2(0.64, 0.13), pos2(0.78, 0.16), pos2(0.9, 0.17), 10));
    right.extend(bez(pos2(0.9, 0.17), pos2(0.92, 0.55), pos2(0.78, 0.8), pos2(0.5, 0.96), 18));
    let mut pts: Vec<Pos2> = right.clone();
    pts.extend(right.iter().rev().skip(1).map(|p| pos2(1.0 - p.x, p.y)));
    pts.pop();
    pts.dedup();
    pts
}

/// Bouclier bleu (dégradé) + trou de serrure.
pub fn paint_logo(painter: &Painter, rect: Rect, hole: Color32) {
    let map = |p: Pos2| rect.min + vec2(p.x * rect.width(), p.y * rect.height());
    let top = hex(0x60a5fa);
    let bot = hex(0x1d4ed8);
    let lerp = |y: f32| {
        let t = y.clamp(0.0, 1.0);
        Color32::from_rgb(
            (top.r() as f32 + (bot.r() as f32 - top.r() as f32) * t) as u8,
            (top.g() as f32 + (bot.g() as f32 - top.g() as f32) * t) as u8,
            (top.b() as f32 + (bot.b() as f32 - top.b() as f32) * t) as u8,
        )
    };
    let pts = shield_points();
    let mut mesh = Mesh::default();
    let c = pos2(0.5, 0.5);
    mesh.colored_vertex(map(c), lerp(c.y));
    for p in &pts {
        mesh.colored_vertex(map(*p), lerp(p.y));
    }
    let n = pts.len() as u32;
    for i in 0..n {
        mesh.add_triangle(0, 1 + i, 1 + (i + 1) % n);
    }
    painter.add(Shape::mesh(mesh));
    // reflet léger sur la moitié gauche
    let shine: Vec<Pos2> = pts.iter().filter(|p| p.x <= 0.5).map(|p| map(*p)).collect();
    if shine.len() > 2 {
        let mut poly = shine;
        poly.push(map(pos2(0.5, 0.96)));
        poly.push(map(pos2(0.5, 0.04)));
        painter.add(Shape::convex_polygon(poly, Color32::from_white_alpha(18), Stroke::NONE));
    }
    // trou de serrure
    let k = rect.width();
    painter.circle_filled(map(pos2(0.5, 0.42)), 0.11 * k, hole);
    painter.add(Shape::convex_polygon(
        vec![map(pos2(0.455, 0.46)), map(pos2(0.545, 0.46)), map(pos2(0.575, 0.72)), map(pos2(0.425, 0.72))],
        hole,
        Stroke::NONE,
    ));
}

pub fn logo(ui: &mut Ui, size: f32) {
    let (rect, _) = ui.allocate_exact_size(vec2(size, size), Sense::hover());
    let p = pal(ui.ctx());
    paint_logo(ui.painter(), rect, if p.dark { p.panel } else { Color32::WHITE });
}

/// Icône de fenêtre (RGBA) rendue par logiciel à partir du même tracé.
pub fn window_icon(size: u32) -> egui::IconData {
    let pts = shield_points();
    let inside_poly = |x: f32, y: f32| {
        let mut inside = false;
        let mut j = pts.len() - 1;
        for i in 0..pts.len() {
            let (a, b) = (pts[i], pts[j]);
            if (a.y > y) != (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x {
                inside = !inside;
            }
            j = i;
        }
        inside
    };
    let hole = |x: f32, y: f32| {
        let d = ((x - 0.5).powi(2) + (y - 0.42).powi(2)).sqrt() < 0.11;
        let t = (0.46..=0.72).contains(&y) && {
            let half = 0.045 + (y - 0.46) / 0.26 * 0.03;
            (x - 0.5).abs() < half
        };
        d || t
    };
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    const SS: u32 = 4;
    for py in 0..size {
        for px in 0..size {
            let mut cov = 0u32;
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = (px as f32 + (sx as f32 + 0.5) / SS as f32) / size as f32;
                    let y = (py as f32 + (sy as f32 + 0.5) / SS as f32) / size as f32;
                    if inside_poly(x, y) && !hole(x, y) {
                        cov += 1;
                    }
                }
            }
            let t = py as f32 / size as f32;
            let (r, g, b) = (0x60 as f32 + (0x1d - 0x60) as f32 * t, 0xa5 as f32 + (0x4e - 0xa5) as f32 * t, 0xfa as f32 + (0xd8 - 0xfa) as f32 * t);
            rgba.extend_from_slice(&[r as u8, g as u8, b as u8, (cov * 255 / (SS * SS)) as u8]);
        }
    }
    egui::IconData { rgba, width: size, height: size }
}

// ------------------------------------------------------------------ icônes dessinées

#[derive(Clone, Copy, PartialEq)]
pub enum Icon {
    Copy,
    Check,
    Eye,
    EyeOff,
    Lock,
    Plus,
    Refresh,
    Edit,
    Trash,
    Star,
    StarFilled,
    Key,
    Search,
    External,
    Close,
    Back,
    Gear,
}

fn arc(c: Pos2, r: f32, a0: f32, a1: f32, n: usize) -> Vec<Pos2> {
    (0..=n).map(|i| a0 + (a1 - a0) * i as f32 / n as f32).map(|a| c + vec2(a.cos(), a.sin()) * r).collect()
}

fn star_points(c: Pos2, r: f32) -> Vec<Pos2> {
    (0..10)
        .map(|i| {
            let a = -PI / 2.0 + i as f32 * PI / 5.0;
            let rr = if i % 2 == 0 { r } else { r * 0.45 };
            c + vec2(a.cos(), a.sin()) * rr
        })
        .collect()
}

/// Dessine une icône au trait dans `rect` (carré conseillé ~16 px).
pub fn paint_icon(p: &Painter, rect: Rect, icon: Icon, color: Color32) {
    let s = rect.width().min(rect.height());
    let c = rect.center();
    let u = s / 16.0; // unité : grille 16×16
    let at = |x: f32, y: f32| c + vec2((x - 8.0) * u, (y - 8.0) * u);
    let st = Stroke::new(1.6 * u.max(0.9), color);
    let line = |pts: Vec<Pos2>| p.add(Shape::line(pts, st));
    match icon {
        Icon::Copy => {
            p.rect_stroke(Rect::from_min_max(at(5.5, 5.5), at(14.0, 14.0)), CornerRadius::same((2.0 * u) as u8), st, StrokeKind::Middle);
            line(vec![at(10.5, 3.0), at(4.0, 3.0), at(2.5, 4.5), at(2.5, 10.5)]);
        }
        Icon::Check => {
            line(vec![at(3.0, 8.5), at(6.5, 12.0), at(13.5, 4.5)]);
        }
        Icon::Eye | Icon::EyeOff => {
            // amande : deux arcs qui se rejoignent en (1,8) et (15,8)
            let half = 1.144;
            let mut eye = arc(at(8.0, 11.19), 7.69 * u, -PI / 2.0 - half, -PI / 2.0 + half, 14);
            eye.extend(arc(at(8.0, 4.81), 7.69 * u, PI / 2.0 - half, PI / 2.0 + half, 14));
            p.add(Shape::closed_line(eye, st));
            p.circle_stroke(at(8.0, 8.0), 2.2 * u, st);
            if icon == Icon::EyeOff {
                line(vec![at(2.5, 2.5), at(13.5, 13.5)]);
            }
        }
        Icon::Lock => {
            p.rect_stroke(Rect::from_min_max(at(3.0, 7.0), at(13.0, 14.5)), CornerRadius::same((2.0 * u) as u8), st, StrokeKind::Middle);
            let mut sh = vec![at(5.0, 7.0)];
            sh.extend(arc(at(8.0, 5.0), 3.0 * u, PI, TAU, 12));
            sh.push(at(11.0, 7.0));
            line(sh);
            p.circle_filled(at(8.0, 10.6), 1.1 * u, color);
        }
        Icon::Plus => {
            line(vec![at(8.0, 2.5), at(8.0, 13.5)]);
            line(vec![at(2.5, 8.0), at(13.5, 8.0)]);
        }
        Icon::Gear => {
            p.circle_stroke(at(8.0, 8.0), 4.4 * u, st);
            p.circle_stroke(at(8.0, 8.0), 1.6 * u, st);
            for i in 0..8 {
                let a = i as f32 * PI / 4.0;
                let d = vec2(a.cos(), a.sin());
                line(vec![at(8.0, 8.0) + d * 4.6 * u, at(8.0, 8.0) + d * 6.6 * u]);
            }
        }
        Icon::Back => {
            line(vec![at(13.5, 8.0), at(2.5, 8.0)]);
            line(vec![at(7.0, 3.5), at(2.5, 8.0), at(7.0, 12.5)]);
        }
        Icon::Close => {
            line(vec![at(3.5, 3.5), at(12.5, 12.5)]);
            line(vec![at(12.5, 3.5), at(3.5, 12.5)]);
        }
        Icon::Refresh => {
            // arc de 270° (droite → bas → gauche → haut) terminé par une flèche vers la droite
            line(arc(at(8.0, 8.5), 5.5 * u, 0.0, PI * 1.5 - 0.25, 24));
            let top = at(8.0, 3.0);
            p.add(Shape::convex_polygon(
                vec![top + vec2(3.0, 0.0) * u, top + vec2(-1.2, 2.8) * u, top + vec2(-1.2, -2.8) * u],
                color,
                Stroke::NONE,
            ));
        }
        Icon::Edit => {
            line(vec![at(3.0, 13.0), at(3.5, 10.5), at(11.0, 3.0), at(13.0, 5.0), at(5.5, 12.5), at(3.0, 13.0)]);
            line(vec![at(9.5, 4.5), at(11.5, 6.5)]);
        }
        Icon::Trash => {
            line(vec![at(2.5, 4.5), at(13.5, 4.5)]);
            line(vec![at(6.0, 4.5), at(6.5, 2.5), at(9.5, 2.5), at(10.0, 4.5)]);
            line(vec![at(4.0, 4.5), at(4.8, 14.0), at(11.2, 14.0), at(12.0, 4.5)]);
            line(vec![at(6.8, 7.0), at(6.8, 11.5)]);
            line(vec![at(9.2, 7.0), at(9.2, 11.5)]);
        }
        Icon::Star | Icon::StarFilled => {
            let pts = star_points(at(8.0, 8.6), 6.6 * u);
            if icon == Icon::StarFilled {
                let mut mesh = Mesh::default();
                mesh.colored_vertex(at(8.0, 8.6), color);
                for q in &pts {
                    mesh.colored_vertex(*q, color);
                }
                for i in 0..10u32 {
                    mesh.add_triangle(0, 1 + i, 1 + (i + 1) % 10);
                }
                p.add(Shape::mesh(mesh));
            } else {
                p.add(Shape::closed_line(pts, st));
            }
        }
        Icon::Key => {
            p.circle_stroke(at(5.0, 11.0), 3.0 * u, st);
            line(vec![at(7.2, 8.8), at(13.5, 2.5)]);
            line(vec![at(11.0, 5.0), at(13.0, 7.0)]);
            line(vec![at(9.2, 6.8), at(10.8, 8.4)]);
        }
        Icon::Search => {
            p.circle_stroke(at(7.0, 7.0), 4.5 * u, st);
            line(vec![at(10.4, 10.4), at(14.0, 14.0)]);
        }
        Icon::External => {
            line(vec![at(7.0, 3.0), at(3.0, 3.0), at(3.0, 13.0), at(13.0, 13.0), at(13.0, 9.0)]);
            line(vec![at(8.0, 8.0), at(14.0, 2.0)]);
            line(vec![at(9.5, 2.0), at(14.0, 2.0), at(14.0, 6.5)]);
        }
    }
}

// ------------------------------------------------------------------ widgets

/// Bouton-icône carré discret, avec infobulle.
pub fn icon_button(ui: &mut Ui, icon: Icon, tip: &str) -> Response {
    icon_button_colored(ui, icon, tip, None)
}

pub fn icon_button_colored(ui: &mut Ui, icon: Icon, tip: &str, color: Option<Color32>) -> Response {
    let p = pal(ui.ctx());
    let (rect, resp) = ui.allocate_exact_size(vec2(32.0, 32.0), Sense::click());
    let hovered = resp.hovered() && ui.is_enabled();
    if hovered {
        ui.painter().rect_filled(rect, CornerRadius::same(8), p.hover);
    }
    let col = color.unwrap_or(if hovered { p.text } else { p.muted });
    paint_icon(ui.painter(), Rect::from_center_size(rect.center(), vec2(16.0, 16.0)), icon, col);
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let enabled = ui.is_enabled();
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, enabled, tip));
    resp.on_hover_text(tip)
}

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Primary,
    Secondary,
    Danger,
    Ghost,
}

/// Bouton avec icône dessinée optionnelle.
pub struct Btn<'a> {
    pub icon: Option<Icon>,
    pub text: &'a str,
    pub kind: Kind,
    pub width: Option<f32>,
    pub height: f32,
}

impl<'a> Btn<'a> {
    pub fn new(text: &'a str) -> Self {
        Btn { icon: None, text, kind: Kind::Secondary, width: None, height: 36.0 }
    }
    pub fn primary(text: &'a str) -> Self {
        Btn { kind: Kind::Primary, ..Self::new(text) }
    }
    pub fn icon(mut self, i: Icon) -> Self {
        self.icon = Some(i);
        self
    }
    pub fn kind(mut self, k: Kind) -> Self {
        self.kind = k;
        self
    }
    pub fn width(mut self, w: f32) -> Self {
        self.width = Some(w);
        self
    }
    pub fn height(mut self, h: f32) -> Self {
        self.height = h;
        self
    }
}

impl Widget for Btn<'_> {
    fn ui(self, ui: &mut Ui) -> Response {
        let p = pal(ui.ctx());
        let font = semibold(14.0);
        let (fg, bg, bg_hover, border) = match self.kind {
            Kind::Primary => (p.on_accent, p.accent, p.accent_lo, None),
            Kind::Secondary => (p.text, p.card, p.hover, Some(p.border)),
            Kind::Danger => (Color32::WHITE, hex(0xdc2626), hex(0xb91c1c), None),
            Kind::Ghost => (p.muted, Color32::TRANSPARENT, p.hover, None),
        };
        let galley = ui.painter().layout_no_wrap(self.text.to_string(), font, fg);
        let icon_w = if self.icon.is_some() { 16.0 + if self.text.is_empty() { 0.0 } else { 8.0 } } else { 0.0 };
        let content_w = icon_w + galley.size().x;
        let w = self.width.unwrap_or(content_w + 28.0).max(content_w + 16.0);
        let (rect, resp) = ui.allocate_exact_size(vec2(w, self.height), Sense::click());
        if ui.is_rect_visible(rect) {
            let hovered = resp.hovered() && ui.is_enabled();
            let fill = if hovered { bg_hover } else { bg };
            let cr = CornerRadius::same(9);
            ui.painter().rect_filled(rect, cr, fill);
            if let Some(b) = border {
                ui.painter().rect_stroke(rect, cr, Stroke::new(1.0, b), StrokeKind::Inside);
            }
            if resp.has_focus() {
                ui.painter().rect_stroke(rect.expand(2.0), CornerRadius::same(11), Stroke::new(2.0, alpha(p.accent, 0.6)), StrokeKind::Inside);
            }
            let fg = if self.kind == Kind::Ghost && hovered { p.text } else { fg };
            let mut x = rect.center().x - content_w / 2.0;
            if let Some(i) = self.icon {
                paint_icon(ui.painter(), Rect::from_min_size(pos2(x, rect.center().y - 8.0), vec2(16.0, 16.0)), i, fg);
                x += icon_w;
            }
            ui.painter().galley_with_override_text_color(pos2(x, rect.center().y - galley.size().y / 2.0), galley, fg);
        }
        if resp.hovered() && ui.is_enabled() {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        let enabled = ui.is_enabled();
        resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, enabled, self.text));
        resp
    }
}

/// Cadre « carte ».
pub fn card(p: &Pal) -> egui::Frame {
    egui::Frame::new()
        .fill(p.card)
        .stroke(Stroke::new(1.0, p.border))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::symmetric(16, 12))
}

/// Libellé discret au-dessus d'une valeur.
pub fn label(ui: &mut Ui, text: &str) {
    let p = pal(ui.ctx());
    ui.label(egui::RichText::new(text.to_uppercase()).font(semibold(11.0)).color(p.muted).extra_letter_spacing(0.6));
}

/// Anneau de compte à rebours (TOTP).
pub fn countdown(ui: &mut Ui, remaining: u64, period: u64) -> Response {
    let p = pal(ui.ctx());
    let (rect, resp) = ui.allocate_exact_size(vec2(30.0, 30.0), Sense::hover());
    let c = rect.center();
    let r = 12.0;
    ui.painter().circle_stroke(c, r, Stroke::new(3.0, p.border));
    let frac = remaining as f32 / period.max(1) as f32;
    let col = if remaining <= 5 { p.danger } else { p.accent };
    if frac > 0.0 {
        let n = (40.0 * frac).ceil() as usize + 1;
        ui.painter().add(Shape::line(arc(c, r, -PI / 2.0, -PI / 2.0 + TAU * frac, n), Stroke::new(3.0, col)));
    }
    ui.painter().text(c, Align2::CENTER_CENTER, remaining.to_string(), semibold(10.5), if remaining <= 5 { p.danger } else { p.muted });
    resp
}

/// Pastille en ligne / hors ligne.
pub fn status_pill(ui: &mut Ui, online: bool) -> Response {
    let p = pal(ui.ctx());
    let (txt, col) = if online { ("En ligne", p.success) } else { ("Hors ligne", p.warn) };
    let galley = ui.painter().layout_no_wrap(txt.into(), semibold(12.0), col);
    let size = vec2(galley.size().x + 30.0, 26.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius::same(13), alpha(col, 0.14));
    ui.painter().circle_filled(pos2(rect.left() + 13.0, rect.center().y), 3.5, col);
    ui.painter().galley(pos2(rect.left() + 22.0, rect.center().y - galley.size().y / 2.0), galley, col);
    resp.on_hover_text(if online {
        "Connecté au serveur"
    } else {
        "Serveur injoignable : lecture seule depuis le cache local"
    })
}

/// Petit indicateur d'activité (trois points animés).
pub fn dots(ui: &mut Ui) {
    let p = pal(ui.ctx());
    let (rect, _) = ui.allocate_exact_size(vec2(26.0, 16.0), Sense::hover());
    let t = ui.input(|i| i.time) as f32;
    for i in 0..3 {
        let phase = ((t * 4.0 - i as f32 * 0.7).sin() + 1.0) / 2.0;
        ui.painter().circle_filled(pos2(rect.left() + 5.0 + i as f32 * 8.0, rect.center().y), 2.2 + phase * 1.2, alpha(p.accent_hi, 0.4 + phase * 0.6));
    }
    ui.ctx().request_repaint();
}
