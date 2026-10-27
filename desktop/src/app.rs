//! Interface egui : configuration, déverrouillage, coffre (liste + détail), édition, générateur.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant};

use biopass::api::{display_server, parse_server, Session, SyncResponse};
use biopass::model::Form;
use biopass::util::{self, get_uris, GenOptions};
use biopass::session::{ClipboardClear, SessionStore, Settings, StayUnlocked};
use biopass::vault::{self, Change, Item, Opened, Storage, Vault};
use biopass::{now_ms, Error};
use eframe::egui::{
    self, pos2, text::LayoutJob, vec2, Align, Align2, Color32, Context, CornerRadius, FontId, Frame, Id, Key, Layout,
    Margin, Modifiers, RichText, ScrollArea, Sense, Stroke, StrokeKind, TextEdit, Ui,
};
use zeroize::{Zeroize, Zeroizing};

use crate::theme::{self, alpha, pal, semibold, Btn, Icon, Kind, Pal};

const SYNC_EVERY: Duration = Duration::from_secs(5 * 60);
const TOAST: Duration = Duration::from_millis(3500);
/// Sous cette largeur, une seule colonne : la liste, ou le détail de l'entrée ouverte.
const COMPACT_W: f32 = 860.0;
/// Sous cette largeur, la barre du haut se resserre (titre masqué, bouton « Nouvelle » en icône).
const NARROW_TOP_W: f32 = 900.0;

// ------------------------------------------------------------------ messages des threads

enum Msg {
    Opened { session: u64, res: Result<Opened, Error> },
    Synced { session: u64, res: Result<SyncResponse, Error>, manual: bool },
    Saved { session: u64, save: Result<u64, Error>, sync: Result<SyncResponse, Error>, ids: Vec<String>, kind: SaveKind },
    Reconnected { session: u64, res: Result<Session, Error>, manual: bool },
}

#[derive(Clone, Copy, PartialEq)]
enum SaveKind {
    Edit,
    Delete,
    Fav,
}

#[derive(Clone, Copy, PartialEq)]
enum Screen {
    Setup,
    Unlock,
    Main,
}

#[derive(Default)]
struct SetupForm {
    server: String,
    user: String,
    password: String,
    confirm: String,
    create: bool,
    code: String,
}

impl SetupForm {
    fn wipe(&mut self) {
        self.password.zeroize();
        self.confirm.zeroize();
        self.code.zeroize();
    }
}

struct Editor {
    id: Option<String>,
    form: Form,
    show_pw: bool,
    show_gen: bool,
    focus: bool,
}

struct Generator {
    value: Zeroizing<String>,
}

struct Toast {
    text: String,
    error: bool,
    at: Instant,
}

#[derive(Default)]
struct DetailState {
    show_password: bool,
    revealed: HashSet<usize>,
    history_open: bool,
    revealed_hist: HashSet<usize>,
    copied: Option<(String, Instant)>,
}

enum Action {
    Copy { text: Zeroizing<String>, what: String, key: String },
    TogglePassword,
    Reveal(usize),
    ToggleHistory,
    RevealHistory(usize),
    Edit,
    Delete,
    ToggleFav,
    Open(String),
}

pub struct App {
    ctx: Context,
    vault: Vault,
    screen: Screen,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    session: u64,
    busy: Option<&'static str>,
    error: Option<String>,
    toast: Option<Toast>,

    setup: SetupForm,
    unlock_pw: String,

    query: String,
    list: Vec<String>,
    list_dirty: bool,
    selected: Option<String>,
    scroll_to_selected: bool,
    detail: DetailState,
    editor: Option<Editor>,
    generator: Option<Generator>,
    gen_opts: GenOptions,
    confirm_delete: Option<String>,
    /// Mise en page une colonne (fenêtre étroite) et, dans ce mode, détail affiché à la place de la liste.
    compact: bool,
    compact_detail: bool,

    clipboard: Option<arboard::Clipboard>,
    clip: Option<(Zeroizing<String>, Instant)>,
    /// Textures des icônes de sites, décodées une seule fois (clé = empreinte de la data URL).
    icons: HashMap<u64, Option<theme::SiteIcon>>,
    last_sync: Instant,

    settings: Settings,
    settings_path: std::path::PathBuf,
    show_settings: bool,
    /// Session persistante (« Rester déverrouillé ») : fichier, échéance glissante (ms, None = jamais),
    /// dernière écriture du fichier.
    sessions: SessionStore,
    deadline: Option<u64>,
    session_written: Instant,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>) -> App {
        theme::install(&cc.egui_ctx);
        let mut vault = Vault::load(Storage::new(Storage::default_path()));
        let settings_path = Storage::default_path().with_file_name("settings.json");
        let settings = Settings::load(&settings_path);
        let sessions = SessionStore::new(SessionStore::default_path());
        // Reprise sans mot de passe si la session n'a pas expiré.
        let mut resumed = false;
        if let Some(s) = sessions.load(now_ms()) {
            resumed = vault.profile.is_some() && vault.resume(&s).is_ok();
        }
        if !resumed {
            sessions.clear();
        }
        let (tx, rx) = channel();
        let screen = if resumed {
            Screen::Main
        } else if vault.profile.is_some() {
            Screen::Unlock
        } else {
            Screen::Setup
        };
        let setup = SetupForm { server: vault.profile.as_ref().map(|p| display_server(&p.server)).unwrap_or_default(), ..Default::default() };
        let mut app = App {
            ctx: cc.egui_ctx.clone(),
            vault,
            screen,
            tx,
            rx,
            session: 0,
            busy: None,
            error: None,
            toast: None,
            setup,
            unlock_pw: String::new(),
            query: String::new(),
            list: Vec::new(),
            list_dirty: true,
            selected: None,
            scroll_to_selected: false,
            detail: DetailState::default(),
            editor: None,
            generator: None,
            gen_opts: GenOptions::default(),
            confirm_delete: None,
            compact: false,
            compact_detail: false,
            clipboard: arboard::Clipboard::new().ok(),
            clip: None,
            icons: HashMap::new(),
            last_sync: Instant::now(),
            settings,
            settings_path,
            show_settings: false,
            sessions,
            deadline: None,
            session_written: Instant::now(),
        };
        if resumed {
            app.persist_session(); // repousse l'échéance
            app.start_sync(false); // login(auth) en arrière-plan pour obtenir un token, puis sync
        }
        app
    }

    // -------------------------------------------------------------- session persistante

    /// Repousse l'échéance (utilisation à l'instant présent) et réécrit le fichier de session.
    fn persist_session(&mut self) {
        self.deadline = self.settings.stay_unlocked.deadline(now_ms());
        self.session_written = Instant::now();
        if let Some(s) = self.vault.session_file(self.deadline) {
            if let Err(e) = self.sessions.save(&s) {
                self.toast(&e.to_string(), true);
            }
        }
    }

    /// Activité de l'utilisateur : échéance repoussée (fichier réécrit au plus une fois par minute).
    fn touch_session(&mut self) {
        if self.screen != Screen::Main || !self.vault.unlocked() {
            return;
        }
        self.deadline = self.settings.stay_unlocked.deadline(now_ms());
        if self.session_written.elapsed() >= Duration::from_secs(60) {
            self.persist_session();
        }
    }

    fn save_settings(&mut self) {
        if let Err(e) = self.settings.save(&self.settings_path) {
            self.toast(&e.to_string(), true);
        }
        if self.vault.unlocked() {
            self.persist_session();
        }
    }

    // -------------------------------------------------------------- threads

    fn spawn(&self, f: impl FnOnce() -> Msg + Send + 'static) {
        let tx = self.tx.clone();
        let ctx = self.ctx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(f());
            ctx.request_repaint();
        });
    }

    fn submit_setup(&mut self) {
        let f = &self.setup;
        // La clé d'accès n'est jamais affichée : si l'adresse saisie n'en contient pas et désigne
        // le même serveur que le profil enregistré, on réutilise la clé connue.
        let server = match parse_server(&f.server) {
            Ok(mut a) if a.base != "." => {
                if a.key.is_empty() {
                    if let Some(known) = self.vault.profile.as_ref().and_then(|p| parse_server(&p.server).ok()) {
                        if known.base == a.base {
                            a.key = known.key;
                        }
                    }
                }
                a.norm()
            }
            _ => String::new(),
        };
        let user = vault::normalize_user(&f.user);
        if let Some(e) = setup_error(f, !server.is_empty(), &user) {
            self.error = Some(e.into());
            return;
        }
        self.error = None;
        self.setup.server = display_server(&server);
        let pw = Zeroizing::new(std::mem::take(&mut self.setup.password));
        let code = Zeroizing::new(self.setup.code.trim().to_string());
        let create = self.setup.create;
        self.setup.wipe();
        self.busy = Some(if create { "Création du compte…" } else { "Connexion…" });
        let session = self.session;
        self.spawn(move || {
            let res =
                if create { vault::remote_register(&server, &user, &pw, &code) } else { vault::remote_login(&server, &user, &pw) };
            Msg::Opened { session, res }
        });
    }

    fn submit_unlock(&mut self) {
        let Some(profile) = self.vault.profile.clone() else { return };
        if self.unlock_pw.is_empty() {
            self.error = Some("Indiquez votre mot de passe".into());
            return;
        }
        self.error = None;
        let pw = Zeroizing::new(std::mem::take(&mut self.unlock_pw));
        self.busy = Some("Déverrouillage…");
        let session = self.session;
        self.spawn(move || Msg::Opened { session, res: vault::remote_unlock(&profile, &pw) });
    }

    fn start_sync(&mut self, manual: bool) {
        if self.busy.is_some() || !self.vault.unlocked() {
            return;
        }
        self.last_sync = Instant::now();
        let session = self.session;
        if self.vault.has_token() {
            let api = self.vault.api.clone();
            let since = self.vault.cache.rev;
            self.busy = Some("Synchronisation…");
            self.spawn(move || Msg::Synced { session, res: api.sync(since), manual });
        } else if let (Some(auth), Some(p)) = (self.vault.auth(), self.vault.profile.clone()) {
            // Déverrouillé hors ligne : tentative de reconnexion avec la clé d'authentification en mémoire.
            let auth = Zeroizing::new(auth.to_string());
            self.busy = Some("Reconnexion…");
            self.spawn(move || Msg::Reconnected { session, res: vault::remote_reconnect(&p.server, &p.user, &auth), manual });
        }
    }

    fn start_save(&mut self, changes: Vec<Change>, kind: SaveKind) {
        if self.busy.is_some() {
            self.toast("Opération en cours, réessayez dans un instant", true);
            return;
        }
        let (body, ids) = match self.vault.prepare_save(&changes) {
            Ok(x) => x,
            Err(e) => return self.toast(&e.to_string(), true),
        };
        let api = self.vault.api.clone();
        let since = self.vault.cache.rev;
        let session = self.session;
        self.busy = Some("Enregistrement…");
        self.spawn(move || {
            let save = api.save(&body);
            let sync = api.sync(since);
            Msg::Saved { session, save, sync, ids, kind }
        });
    }

    fn handle_messages(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            let session = match &msg {
                Msg::Opened { session, .. }
                | Msg::Synced { session, .. }
                | Msg::Saved { session, .. }
                | Msg::Reconnected { session, .. } => *session,
            };
            if session != self.session {
                continue; // résultat d'une session verrouillée entre-temps
            }
            self.busy = None;
            match msg {
                Msg::Opened { res, .. } => self.on_opened(res),
                Msg::Synced { res, manual, .. } => {
                    let was_online = self.vault.online;
                    match self.vault.apply_sync(res) {
                        Ok(changed) => {
                            if changed {
                                self.list_dirty = true;
                            }
                            if manual {
                                if self.vault.online {
                                    self.toast("Coffre à jour", false);
                                } else {
                                    self.toast("Serveur injoignable : lecture seule", true);
                                }
                            } else if was_online && !self.vault.online {
                                self.toast("Connexion perdue : lecture seule", true);
                            }
                        }
                        Err(e) => self.on_session_error(e),
                    }
                }
                Msg::Reconnected { res, manual, .. } => match res {
                    Ok(s) => {
                        if let Err(e) = self.vault.apply_reconnect(s) {
                            self.toast(&e.to_string(), true);
                        }
                        if manual {
                            self.toast("De nouveau en ligne", false);
                        }
                        self.start_sync(false);
                    }
                    Err(Error::Offline) => {
                        if manual {
                            self.toast("Serveur toujours injoignable", true);
                        }
                    }
                    Err(e) => self.on_session_error(e),
                },
                Msg::Saved { save, sync, ids, kind, .. } => {
                    match self.vault.apply_sync(sync) {
                        Ok(_) => self.list_dirty = true,
                        Err(e) if e.status() == 401 => return self.on_session_error(e),
                        Err(_) => {}
                    }
                    match save {
                        Ok(_) => {
                            match kind {
                                SaveKind::Edit => {
                                    let created = self.editor.as_ref().is_some_and(|e| e.id.is_none());
                                    self.editor = None;
                                    self.selected = ids.first().cloned();
                                    self.scroll_to_selected = true;
                                    self.toast(if created { "Entrée créée" } else { "Entrée enregistrée" }, false);
                                }
                                SaveKind::Delete => {
                                    self.selected = None;
                                    self.toast("Entrée supprimée", false);
                                }
                                SaveKind::Fav => {}
                            }
                            self.list_dirty = true;
                        }
                        Err(Error::Http { status: 409, .. }) => {
                            self.toast(
                                "Conflit : cette entrée a été modifiée sur un autre appareil. Le coffre a été resynchronisé ; vérifiez puis enregistrez à nouveau.",
                                true,
                            );
                        }
                        Err(Error::Offline) => {
                            self.vault.online = false;
                            self.toast("Serveur injoignable : modification non enregistrée", true);
                        }
                        Err(e) => self.on_session_error(e),
                    }
                }
            }
        }
    }

    fn on_opened(&mut self, res: Result<Opened, Error>) {
        match res {
            Ok(o) => {
                if let Err(e) = self.vault.apply_open(o) {
                    self.toast(&e.to_string(), true);
                }
                self.setup.wipe();
                self.unlock_pw.zeroize();
                self.error = None;
                self.screen = Screen::Main;
                self.query.clear();
                self.selected = None;
                self.list_dirty = true;
                self.detail = DetailState::default();
                self.persist_session();
                if self.vault.has_token() {
                    self.start_sync(false);
                } else {
                    self.toast("Serveur injoignable : lecture seule depuis le cache", true);
                }
            }
            Err(e) => {
                self.error = Some(match &e {
                    Error::Offline => "Serveur injoignable. Vérifiez l'adresse et votre connexion.".into(),
                    _ => e.to_string(),
                });
            }
        }
    }

    /// 401 pendant une session → verrouillage ; autres erreurs → message.
    fn on_session_error(&mut self, e: Error) {
        if e.status() == 401 {
            self.lock(Some("Session expirée, déverrouillez à nouveau".into()));
        } else {
            self.toast(&e.to_string(), true);
        }
    }

    fn lock(&mut self, reason: Option<String>) {
        self.clear_clipboard_if_ours();
        self.vault.lock();
        self.icons.clear();
        self.sessions.clear(); // « Verrouiller » efface la clé conservée sur ce poste
        self.deadline = None;
        self.show_settings = false;
        self.session += 1;
        self.busy = None;
        self.editor = None;
        self.generator = None;
        self.confirm_delete = None;
        self.query.clear();
        self.list.clear();
        self.selected = None;
        self.detail = DetailState::default();
        self.unlock_pw.zeroize();
        self.screen = if self.vault.profile.is_some() { Screen::Unlock } else { Screen::Setup };
        self.error = reason;
    }

    // -------------------------------------------------------------- presse-papiers

    fn copy(&mut self, text: &str, what: &str) {
        if text.is_empty() {
            return;
        }
        let ok = match &mut self.clipboard {
            Some(cb) => {
                #[cfg(target_os = "linux")]
                use arboard::SetExtLinux;
                #[cfg(target_os = "windows")]
                use arboard::SetExtWindows;
                #[cfg(target_os = "macos")]
                use arboard::SetExtApple;
                cb.set().exclude_from_history().text(text.to_string()).is_ok()
            }
            None => false,
        };
        if ok && self.settings.clipboard_clear != ClipboardClear::Never {
            self.clip = Some((Zeroizing::new(text.to_string()), Instant::now()));
            self.toast(&format!("{what} copié · effacé dans {}", self.settings.clipboard_clear.label()), false);
        } else if ok {
            self.clip = None;
            self.toast(&format!("{what} copié"), false);
        } else {
            self.ctx.copy_text(text.to_string());
            self.toast(&format!("{what} copié"), false);
        }
    }

    fn clear_clipboard_if_ours(&mut self) {
        if let (Some((ours, _)), Some(cb)) = (&self.clip, &mut self.clipboard) {
            if cb.get_text().ok().as_deref() == Some(ours.as_str()) {
                let _ = cb.clear();
            }
        }
        self.clip = None;
    }

    fn toast(&mut self, text: &str, error: bool) {
        self.toast = Some(Toast { text: text.into(), error, at: Instant::now() });
    }

    // -------------------------------------------------------------- liste

    fn refilter(&mut self) {
        self.list_dirty = false;
        let items = self.vault.items.values().map(|it| (&it.fz, it.id.clone()));
        self.list = util::search(items, &self.query);
        if self.selected.as_ref().is_none_or(|s| !self.list.contains(s)) {
            let changed = self.selected != self.list.first().cloned();
            self.selected = if self.query.trim().is_empty() && self.selected.is_none() { None } else { self.list.first().cloned() };
            if changed {
                self.detail = DetailState::default();
            }
        }
    }

    fn select_offset(&mut self, d: i32) {
        if self.list.is_empty() {
            return;
        }
        let cur = self.selected.as_ref().and_then(|s| self.list.iter().position(|x| x == s));
        let n = self.list.len() as i32;
        let next = match cur {
            None => if d > 0 { 0 } else { n - 1 },
            Some(i) => (i as i32 + d).clamp(0, n - 1),
        };
        self.select(self.list[next as usize].clone());
        self.scroll_to_selected = true;
    }

    fn select(&mut self, id: String) {
        if self.selected.as_ref() != Some(&id) {
            self.detail = DetailState::default();
        }
        self.selected = Some(id);
    }

    fn selected_item(&self) -> Option<&Item> {
        self.selected.as_ref().and_then(|id| self.vault.items.get(id))
    }

    fn can_edit(&self) -> bool {
        self.vault.online && self.vault.has_token()
    }

    fn new_entry(&mut self) {
        if !self.can_edit() {
            return self.toast("Hors ligne : modification impossible", true);
        }
        let mut form = Form::default();
        if !self.query.trim().is_empty() {
            form.name = self.query.trim().to_string();
        }
        self.editor = Some(Editor { id: None, form, show_pw: false, show_gen: false, focus: true });
    }

    fn edit_selected(&mut self) {
        if !self.can_edit() {
            return self.toast("Hors ligne : modification impossible", true);
        }
        if let Some(it) = self.selected_item() {
            let form = Form::from_item(&it.data);
            let id = it.id.clone();
            self.editor = Some(Editor { id: Some(id), form, show_pw: false, show_gen: false, focus: true });
        }
    }

    fn save_editor(&mut self) {
        let Some(ed) = &self.editor else { return };
        if ed.form.name.trim().is_empty() {
            return self.toast("Le nom est obligatoire", true);
        }
        if !ed.form.totp.trim().is_empty() && util::totp(&ed.form.totp, now_ms()).is_none() {
            return self.toast("Secret TOTP invalide", true);
        }
        // Base = version la plus récente de l'entrée (champs inconnus conservés).
        let base = ed.id.as_ref().and_then(|id| self.vault.items.get(id)).map(|it| it.data.clone()).unwrap_or_default();
        let mut data = biopass::model::with_history(&base, ed.form.apply(&base), now_ms());
        biopass::icon::reset_icon_if_site_changed(&base, &mut data);
        let change = Change::Upsert { id: ed.id.clone(), data };
        self.start_save(vec![change], SaveKind::Edit);
    }

    fn copy_field(&mut self, field: &str, what: &str) {
        let Some(it) = self.selected_item() else { return };
        let text = Zeroizing::new(it.str(field).to_string());
        if text.is_empty() {
            return self.toast(&format!("Pas de {} pour cette entrée", what.to_lowercase()), true);
        }
        self.copy(&text, what);
        self.detail.copied = Some((field.into(), Instant::now()));
    }

    fn copy_totp(&mut self) {
        let Some(it) = self.selected_item() else { return };
        match util::totp(it.str("totp"), now_ms()) {
            Some(t) => {
                let code = Zeroizing::new(t.code);
                self.copy(&code, "Code TOTP");
                self.detail.copied = Some(("totp".into(), Instant::now()));
            }
            None => self.toast("Pas de TOTP pour cette entrée", true),
        }
    }

    // -------------------------------------------------------------- raccourcis

    fn shortcuts(&mut self, ctx: &Context) {
        let cmd = Modifiers::COMMAND;
        let key = |m: Modifiers, k: Key| ctx.input_mut(|i| i.consume_key(m, k));
        if key(cmd, Key::L) {
            return self.lock(None);
        }
        if self.editor.is_some() {
            if key(Modifiers::NONE, Key::Escape) {
                self.editor = None;
            } else if key(cmd, Key::S) {
                self.save_editor();
            }
            return;
        }
        if self.generator.is_some() || self.confirm_delete.is_some() || self.show_settings {
            if key(Modifiers::NONE, Key::Escape) {
                self.generator = None;
                self.confirm_delete = None;
                self.show_settings = false;
            }
            return;
        }
        if key(Modifiers::NONE, Key::ArrowDown) {
            self.select_offset(1);
        }
        if key(Modifiers::NONE, Key::ArrowUp) {
            self.select_offset(-1);
        }
        if key(Modifiers::NONE, Key::Enter) {
            self.copy_field("password", "Mot de passe");
        }
        if key(cmd, Key::U) {
            self.copy_field("username", "Identifiant");
        }
        if key(cmd, Key::T) {
            self.copy_totp();
        }
        if key(cmd, Key::N) {
            self.new_entry();
        }
        if key(Modifiers::NONE, Key::Escape) {
            if self.compact && self.compact_detail {
                self.compact_detail = false; // retour à la liste
                self.scroll_to_selected = true;
            } else if self.query.is_empty() {
                self.selected = None;
            } else {
                self.query.clear();
                self.list_dirty = true;
            }
        }
    }

    // -------------------------------------------------------------- écrans

    fn centered_card(ui: &mut Ui, height: f32, add: impl FnOnce(&mut Ui)) {
        let p = pal(ui.ctx());
        ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
            let top = ((ui.available_height() - height) / 2.0).max(24.0);
            ui.add_space(top);
            ui.vertical_centered(|ui| {
                Frame::new()
                    .fill(p.panel)
                    .stroke(Stroke::new(1.0, p.border))
                    .corner_radius(CornerRadius::same(18))
                    .inner_margin(Margin::same(32))
                    .shadow(egui::Shadow { offset: [0, 16], blur: 48, spread: 0, color: Color32::from_black_alpha(if p.dark { 120 } else { 22 }) })
                    .show(ui, |ui| {
                        ui.set_width(340.0);
                        add(ui);
                    });
            });
            ui.add_space(24.0);
        });
    }

    fn brand(ui: &mut Ui, title: &str, subtitle: &str) {
        let p = pal(ui.ctx());
        ui.vertical_centered(|ui| {
            theme::logo(ui, 64.0);
            ui.add_space(10.0);
            ui.label(RichText::new(title).font(semibold(24.0)).color(p.text));
            ui.add_space(2.0);
            ui.label(RichText::new(subtitle).size(13.5).color(p.muted));
        });
        ui.add_space(18.0);
    }

    fn error_line(&self, ui: &mut Ui) {
        if let Some(e) = &self.error {
            let p = pal(ui.ctx());
            Frame::new()
                .fill(alpha(p.danger, 0.12))
                .corner_radius(CornerRadius::same(8))
                .inner_margin(Margin::symmetric(12, 8))
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.label(RichText::new(e).color(p.danger).size(13.5));
                });
            ui.add_space(6.0);
        }
    }

    fn ui_setup(&mut self, ui: &mut Ui) {
        let busy = self.busy.is_some();
        let has_profile = self.vault.profile.is_some();
        let mut submit = false;
        let mut back = false;
        let h = if self.setup.create { 640.0 } else { 520.0 };
        Self::centered_card(ui, h, |ui| {
            Self::brand(ui, "Bienvenue", "Connectez-vous à votre serveur BioPass familial");
            ui.with_layout(Layout::top_down(Align::Min), |ui| {
                ui.add_enabled_ui(!busy, |ui| {
                    let s = &mut self.setup;
                    input(ui, "Adresse du serveur", &mut s.server, "https://exemple.fr/biopass/?k=…", false, None);
                    input(ui, "Identifiant", &mut s.user, "prenom", false, None);
                    let r = input(ui, "Mot de passe maître", &mut s.password, "", true, None);
                    submit |= enter_pressed(ui, &r) && !s.create;
                    ui.add_space(2.0);
                    ui.checkbox(&mut s.create, "Créer un compte");
                    if s.create {
                        ui.add_space(4.0);
                        input(ui, "Confirmer le mot de passe", &mut s.confirm, "", true, None);
                        let r = input(ui, "Code d'inscription", &mut s.code, "fourni par l'administrateur", true, None);
                        submit |= enter_pressed(ui, &r);
                    }
                });
                ui.add_space(8.0);
                self.error_line(ui);
                let label = if self.setup.create { "Créer le compte" } else { "Se connecter" };
                if busy {
                    busy_row(ui, self.busy.unwrap_or(""));
                } else if ui.add(Btn::primary(label).width(ui.available_width()).height(42.0)).clicked() {
                    submit = true;
                }
                if has_profile {
                    ui.add_space(6.0);
                    ui.vertical_centered(|ui| {
                        if ui.add(Btn::new("Retour au déverrouillage").kind(Kind::Ghost)).clicked() {
                            back = true;
                        }
                    });
                }
            });
        });
        if submit && !busy {
            self.submit_setup();
        }
        if back && !busy {
            self.error = None;
            self.setup.wipe();
            self.screen = Screen::Unlock;
        }
    }

    fn ui_unlock(&mut self, ui: &mut Ui) {
        let p = pal(ui.ctx());
        let busy = self.busy.is_some();
        let (user, host) = self
            .vault
            .profile
            .as_ref()
            .map(|pr| (pr.user.clone(), util::host_of(&display_server(&pr.server))))
            .unwrap_or_default();
        let mut submit = false;
        let mut switch = false;
        Self::centered_card(ui, 440.0, |ui| {
            Self::brand(ui, "BioPass", "Votre coffre est verrouillé");
            ui.vertical_centered(|ui| {
                Frame::new().fill(p.card).corner_radius(CornerRadius::same(20)).inner_margin(Margin::symmetric(6, 4)).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        theme::avatar(ui, 24.0, &user);
                        ui.label(RichText::new(&user).font(semibold(13.5)));
                        ui.label(RichText::new(format!("· {host}")).size(13.0).color(p.muted));
                        ui.add_space(4.0);
                    });
                });
            });
            ui.add_space(14.0);
            ui.with_layout(Layout::top_down(Align::Min), |ui| {
                let r = ui.add_enabled(
                    !busy,
                    TextEdit::singleline(&mut self.unlock_pw)
                        .password(true)
                        .hint_text("Mot de passe maître")
                        .desired_width(f32::INFINITY)
                        .margin(Margin::symmetric(12, 10))
                        .font(FontId::proportional(15.0)),
                );
                // Tester Entrée AVANT de redonner le focus (sinon `lost_focus` redevient faux).
                submit |= enter_pressed(ui, &r);
                if !busy && !submit && ui.ctx().memory(|m| m.focused().is_none()) {
                    r.request_focus();
                }
                ui.add_space(8.0);
                self.error_line(ui);
                if busy {
                    busy_row(ui, self.busy.unwrap_or(""));
                } else if ui.add(Btn::primary("Déverrouiller").icon(Icon::Lock).width(ui.available_width()).height(42.0)).clicked() {
                    submit = true;
                }
                ui.add_space(6.0);
                ui.vertical_centered(|ui| {
                    if ui.add_enabled(!busy, Btn::new("Changer d'utilisateur").kind(Kind::Ghost)).clicked() {
                        switch = true;
                    }
                });
            });
        });
        if submit && !busy {
            self.submit_unlock();
        }
        if switch {
            self.error = None;
            self.unlock_pw.zeroize();
            self.setup = SetupForm { server: self.vault.profile.as_ref().map(|p| display_server(&p.server)).unwrap_or_default(), ..Default::default() };
            self.screen = Screen::Setup;
        }
    }

    fn ui_main(&mut self, root: &mut Ui) {
        let ctx = root.ctx().clone();
        let p = pal(&ctx);
        self.compact = ctx.content_rect().width() < COMPACT_W;
        self.shortcuts(&ctx);
        if self.list_dirty {
            self.refilter();
        }

        egui::Panel::top("top")
            .frame(Frame::new().fill(p.panel).inner_margin(Margin::symmetric(16, 10)))
            .show(root, |ui| self.top_bar(ui));

        if !self.vault.online {
            egui::Panel::top("offline")
                .frame(Frame::new().fill(theme::mix(p.panel, p.warn, 0.12)).inner_margin(Margin::symmetric(16, 6)))
                .show_separator_line(false)
                .show(root, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Hors ligne").font(semibold(13.0)).color(p.warn));
                        ui.label(
                            RichText::new("Lecture seule depuis le cache local. La reconnexion est tentée automatiquement.")
                                .size(13.0)
                                .color(p.muted),
                        );
                    });
                });
        }

        if self.compact {
            // Une colonne : la liste, ou le détail de l'entrée ouverte (Échap ou « Liste » pour revenir).
            let show_detail = self.compact_detail && self.selected_item().is_some();
            if show_detail {
                egui::CentralPanel::default()
                    .frame(Frame::new().fill(p.bg).inner_margin(Margin { left: 20, right: 20, top: 10, bottom: 16 }))
                    .show(root, |ui| {
                        let r = ui.add(Btn::new("Liste").icon(Icon::Back).kind(Kind::Ghost).height(32.0));
                        if r.on_hover_text("Retour à la liste (Échap)").clicked() {
                            self.compact_detail = false;
                            self.scroll_to_selected = true;
                        }
                        ui.add_space(6.0);
                        self.detail_panel(ui);
                    });
            } else {
                egui::CentralPanel::default()
                    .frame(Frame::new().fill(p.panel).inner_margin(Margin::symmetric(12, 12)))
                    .show(root, |ui| self.list_ui(ui));
            }
        } else {
            let max_list = (ctx.content_rect().width() * 0.45).max(260.0);
            egui::Panel::left("list")
                .resizable(true)
                .default_size(320.0)
                .size_range(260.0..=max_list.min(560.0))
                .frame(Frame::new().fill(p.panel).inner_margin(Margin::symmetric(10, 12)))
                .show(root, |ui| self.list_ui(ui));

            egui::CentralPanel::default()
                .frame(Frame::new().fill(p.bg).inner_margin(Margin::symmetric(28, 22)))
                .show(root, |ui| self.detail_panel(ui));
        }

        self.editor_modal(&ctx);
        self.generator_modal(&ctx);
        self.confirm_modal(&ctx);
        self.settings_modal(&ctx);
    }

    fn top_bar(&mut self, ui: &mut Ui) {
        let p = pal(ui.ctx());
        let modal = self.editor.is_some() || self.generator.is_some() || self.confirm_delete.is_some() || self.show_settings;
        ui.horizontal(|ui| {
            ui.set_height(36.0);
            let narrow = ui.ctx().content_rect().width() < NARROW_TOP_W;
            theme::logo(ui, 26.0);
            if !narrow {
                ui.label(RichText::new("BioPass").font(semibold(17.0)));
            }
            ui.add_space(if narrow { 8.0 } else { 18.0 });

            // champ de recherche
            let w = (ui.available_width() - if narrow { 336.0 } else { 456.0 }).clamp(160.0, 620.0);
            let id = Id::unique("search");
            let focused = ui.ctx().memory(|m| m.has_focus(id));
            Frame::new()
                .fill(p.input)
                .stroke(Stroke::new(1.0, if focused { alpha(p.accent, 0.8) } else { p.border }))
                .corner_radius(CornerRadius::same(10))
                .inner_margin(Margin { left: 10, right: 6, top: 3, bottom: 3 })
                .show(ui, |ui| {
                    ui.set_width(w);
                    ui.horizontal(|ui| {
                        let (r, _) = ui.allocate_exact_size(vec2(16.0, 16.0), Sense::hover());
                        theme::paint_icon(ui.painter(), r, Icon::Search, p.muted);
                        let tw = ui.available_width() - if self.query.is_empty() { 0.0 } else { 34.0 };
                        let resp = ui.add(
                            TextEdit::singleline(&mut self.query)
                                .id(id)
                                .frame(Frame::NONE)
                                .hint_text("Rechercher… (tapez simplement)")
                                .align(Align2::LEFT_CENTER)
                                .min_size(vec2(0.0, 28.0))
                                .desired_width(tw)
                                .margin(Margin::symmetric(4, 6))
                                .font(FontId::proportional(14.5)),
                        );
                        if resp.changed() {
                            self.list_dirty = true;
                            self.compact_detail = false; // en mode une colonne, la frappe ramène à la liste
                        }
                        if !self.query.is_empty() && theme::icon_button(ui, Icon::Close, "Effacer (Échap)").clicked() {
                            self.query.clear();
                            self.list_dirty = true;
                        }
                        if !modal && ui.ctx().memory(|m| m.focused().is_none()) {
                            resp.request_focus();
                        }
                    });
                });

            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if theme::icon_button(ui, Icon::Lock, "Verrouiller (Ctrl+L)").clicked() {
                    self.lock(None);
                    return;
                }
                if theme::icon_button(ui, Icon::Gear, "Réglages").clicked() {
                    self.show_settings = true;
                }
                if theme::icon_button(ui, Icon::Key, "Générateur de mot de passe").clicked() {
                    self.generator = Some(Generator { value: Zeroizing::new(util::generate_password(&self.gen_opts)) });
                }
                if self.busy.is_some() {
                    theme::dots(ui);
                } else if theme::icon_button(ui, Icon::Refresh, "Synchroniser").clicked() {
                    self.start_sync(true);
                }
                ui.add_space(4.0);
                let can = self.can_edit();
                let btn = if narrow { Btn::primary("").icon(Icon::Plus).width(36.0) } else { Btn::primary("Nouvelle").icon(Icon::Plus) };
                let r = ui.add_enabled(can, btn.height(34.0));
                if r.clicked() {
                    self.new_entry();
                }
                r.on_hover_text(if can { "Nouvelle entrée (Ctrl+N)" } else { "Hors ligne : lecture seule" });
                ui.add_space(6.0);
                theme::status_pill(ui, self.vault.online);
            });
        });
    }

    fn list_ui(&mut self, ui: &mut Ui) {
        let p = pal(ui.ctx());
        ui.horizontal(|ui| {
            ui.add_space(6.0);
            ui.label(RichText::new("Coffre").font(semibold(15.0)));
            let n = self.list.len();
            let total = self.vault.items.len();
            let txt = if n == total { format!("{total} entrée{}", if total > 1 { "s" } else { "" }) } else { format!("{n} / {total}") };
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.add_space(6.0);
                ui.label(RichText::new(txt).size(12.5).color(p.muted));
            });
        });
        ui.add_space(6.0);

        if self.list.is_empty() {
            ui.add_space(40.0);
            ui.vertical_centered(|ui| {
                let msg = if self.vault.items.is_empty() {
                    "Aucune entrée pour l'instant.\nCréez-en une avec Ctrl+N.".to_string()
                } else {
                    format!("Aucun résultat pour « {} »", self.query.trim())
                };
                ui.label(RichText::new(msg).color(p.muted).size(13.5));
            });
            return;
        }

        let mut clicked = None;
        let mut dbl = None;
        ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            for id in &self.list {
                let Some(it) = self.vault.items.get(id) else { continue };
                let sel = self.selected.as_ref() == Some(id);
                let w = ui.available_width();
                let (rect, resp) = ui.allocate_exact_size(vec2(w, 56.0), Sense::click());
                let label = it.name().to_string();
                resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, &label));
                if ui.is_rect_visible(rect) {
                    let painter = ui.painter();
                    let cr = CornerRadius::same(10);
                    if sel {
                        painter.rect_filled(rect, cr, alpha(p.accent, if p.dark { 0.20 } else { 0.12 }));
                        painter.rect_stroke(rect, cr, Stroke::new(1.0, alpha(p.accent, 0.45)), StrokeKind::Inside);
                    } else if resp.hovered() {
                        painter.rect_filled(rect, cr, p.hover);
                    }
                    let av = egui::Rect::from_min_size(pos2(rect.left() + 10.0, rect.center().y - 18.0), vec2(36.0, 36.0));
                    let site = icon_texture(&mut self.icons, ui.ctx(), it);
                    theme::paint_item_avatar(ui, av, it.name(), it.kind, site.as_ref().map(|s| (s, it.str("iconTone"))));
                    let painter = ui.painter();
                    let fav_w = if it.fav() { 26.0 } else { 6.0 };
                    let tx = av.right() + 12.0;
                    let tw = (rect.right() - tx - fav_w - 6.0).max(20.0);
                    let name = if it.name().is_empty() { "(sans nom)" } else { it.name() };
                    let g1 = truncated(ui, name, semibold(14.5), p.text, tw);
                    let sub = subtitle(it);
                    let g2 = truncated(ui, &sub, FontId::proportional(12.5), p.muted, tw);
                    let total_h = g1.size().y + 2.0 + if sub.is_empty() { 0.0 } else { g2.size().y };
                    let y = rect.center().y - total_h / 2.0;
                    painter.galley(pos2(tx, y), g1.clone(), p.text);
                    if !sub.is_empty() {
                        painter.galley(pos2(tx, y + g1.size().y + 2.0), g2, p.muted);
                    }
                    if it.fav() {
                        let r = egui::Rect::from_center_size(pos2(rect.right() - 18.0, rect.center().y), vec2(14.0, 14.0));
                        theme::paint_icon(painter, r, Icon::StarFilled, p.warn);
                    }
                }
                if sel && self.scroll_to_selected {
                    resp.scroll_to_me(None);
                }
                if resp.double_clicked() {
                    dbl = Some(id.clone());
                } else if resp.clicked() {
                    clicked = Some(id.clone());
                }
                if resp.hovered() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                }
            }
        });
        self.scroll_to_selected = false;
        if let Some(id) = clicked {
            self.select(id);
            self.compact_detail = true;
        }
        if let Some(id) = dbl {
            self.select(id);
            self.compact_detail = true;
            self.copy_field("password", "Mot de passe");
        }
    }

    fn detail_panel(&mut self, ui: &mut Ui) {
        let Some(it) = self.selected.as_ref().and_then(|id| self.vault.items.get(id)) else {
            empty_state(ui);
            return;
        };
        let site = icon_texture(&mut self.icons, ui.ctx(), it);
        let can_edit = self.can_edit() && self.busy.is_none();
        let actions = detail_ui(ui, it, site.as_ref(), &self.detail, can_edit);
        for a in actions {
            match a {
                Action::Copy { text, what, key } => {
                    self.copy(&text, &what);
                    self.detail.copied = Some((key, Instant::now()));
                }
                Action::TogglePassword => self.detail.show_password = !self.detail.show_password,
                Action::Reveal(i) => {
                    if !self.detail.revealed.remove(&i) {
                        self.detail.revealed.insert(i);
                    }
                }
                Action::ToggleHistory => self.detail.history_open = !self.detail.history_open,
                Action::RevealHistory(i) => {
                    if !self.detail.revealed_hist.remove(&i) {
                        self.detail.revealed_hist.insert(i);
                    }
                }
                Action::Edit => self.edit_selected(),
                Action::Delete => {
                    if self.can_edit() {
                        self.confirm_delete = self.selected.clone();
                    }
                }
                Action::ToggleFav => {
                    if let Some(it) = self.selected_item() {
                        let mut data = it.data.clone();
                        let fav = !it.fav();
                        data.insert("fav".into(), fav.into());
                        let id = it.id.clone();
                        self.start_save(vec![Change::Upsert { id: Some(id), data }], SaveKind::Fav);
                    }
                }
                Action::Open(url) => ui.ctx().open_url(egui::OpenUrl::new_tab(url)),
            }
        }
    }

    // -------------------------------------------------------------- fenêtres modales

    fn modal_frame(p: &Pal) -> Frame {
        Frame::new()
            .fill(p.panel)
            .stroke(Stroke::new(1.0, p.border))
            .corner_radius(CornerRadius::same(16))
            .inner_margin(Margin::same(24))
            .shadow(egui::Shadow { offset: [0, 18], blur: 50, spread: 0, color: Color32::from_black_alpha(if p.dark { 160 } else { 50 }) })
    }

    fn editor_modal(&mut self, ctx: &Context) {
        let Some(ed) = &mut self.editor else { return };
        let p = pal(ctx);
        let busy = self.busy.is_some();
        let mut save = false;
        let mut cancel = false;
        let gen_opts = &mut self.gen_opts;
        egui::Modal::new(Id::unique("editor"))
            .frame(Self::modal_frame(&p))
            .backdrop_color(Color32::from_black_alpha(140))
            .show(ctx, |ui| {
                ui.set_width(520.0);
                ui.horizontal(|ui| {
                    theme::avatar(ui, 40.0, if ed.form.name.is_empty() { "?" } else { &ed.form.name });
                    ui.add_space(4.0);
                    ui.vertical(|ui| {
                        ui.label(RichText::new(if ed.id.is_some() { "Modifier l'entrée" } else { "Nouvelle entrée" }).font(semibold(19.0)));
                        ui.label(RichText::new("Ctrl+S pour enregistrer · Échap pour annuler").size(12.0).color(p.muted));
                    });
                });
                ui.add_space(12.0);
                let max_h = (ctx.content_rect().height() - 220.0).max(200.0);
                ScrollArea::vertical().max_height(max_h).auto_shrink([false, true]).show(ui, |ui| {
                    ui.add_enabled_ui(!busy, |ui| {
                        let f = &mut ed.form;
                        let r = input(ui, "Nom", &mut f.name, "GitHub, Banque…", false, None);
                        if ed.focus {
                            r.request_focus();
                            ed.focus = false;
                        }
                        input(ui, "Identifiant", &mut f.username, "adresse e-mail ou nom d'utilisateur", false, None);

                        theme::label(ui, "Mot de passe");
                        ui.horizontal(|ui| {
                            let w = ui.available_width() - 80.0;
                            ui.add(
                                TextEdit::singleline(&mut f.password)
                                    .password(!ed.show_pw)
                                    .desired_width(w)
                                    .margin(Margin::symmetric(10, 8))
                                    .font(FontId::monospace(14.0)),
                            );
                            let eye = if ed.show_pw { Icon::EyeOff } else { Icon::Eye };
                            if theme::icon_button(ui, eye, if ed.show_pw { "Masquer" } else { "Afficher" }).clicked() {
                                ed.show_pw = !ed.show_pw;
                            }
                            let gr = theme::icon_button_colored(ui, Icon::Key, "Générer un mot de passe", Some(p.accent_hi));
                            if gr.clicked() {
                                f.password.zeroize();
                                f.password = util::generate_password(gen_opts);
                                ed.show_pw = true;
                                ed.show_gen = true;
                            }
                        });
                        if ed.show_gen {
                            ui.add_space(2.0);
                            Frame::new().fill(p.card).corner_radius(CornerRadius::same(10)).inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
                                ui.set_width(ui.available_width());
                                if gen_controls(ui, gen_opts) {
                                    f.password.zeroize();
                                    f.password = util::generate_password(gen_opts);
                                }
                            });
                        }
                        ui.add_space(8.0);

                        theme::label(ui, "Sites (une adresse par ligne)");
                        ui.add(
                            TextEdit::multiline(&mut f.uris)
                                .desired_rows(2)
                                .desired_width(f32::INFINITY)
                                .margin(Margin::symmetric(10, 8))
                                .hint_text("https://exemple.fr"),
                        );
                        ui.add_space(8.0);

                        let preview = if f.totp.trim().is_empty() { None } else { Some(util::totp(&f.totp, now_ms())) };
                        input(ui, "TOTP (authentification à deux facteurs)", &mut f.totp, "otpauth://totp/… ou secret base32", false, None);
                        match preview {
                            Some(Some(t)) => {
                                ui.label(RichText::new(format!("Code actuel : {}", group_code(&t.code))).size(12.5).color(p.success));
                            }
                            Some(None) => {
                                ui.label(RichText::new("Secret TOTP invalide").size(12.5).color(p.danger));
                            }
                            None => {}
                        }

                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.set_width(ui.available_width() - 150.0);
                                input(ui, "Dossier", &mut f.folder, "Perso, Travail…", false, None);
                            });
                            ui.vertical(|ui| {
                                ui.add_space(26.0);
                                ui.checkbox(&mut f.fav, "Favori");
                            });
                        });

                        theme::label(ui, "Notes");
                        ui.add(TextEdit::multiline(&mut f.notes).desired_rows(3).desired_width(f32::INFINITY).margin(Margin::symmetric(10, 8)));
                    });
                });
                ui.add_space(16.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if busy {
                        busy_row(ui, "Enregistrement…");
                    } else {
                        if ui.add(Btn::primary("Enregistrer").icon(Icon::Check)).clicked() {
                            save = true;
                        }
                        if ui.add(Btn::new("Annuler")).clicked() {
                            cancel = true;
                        }
                    }
                });
            });
        if cancel {
            self.editor = None;
        }
        if save {
            self.save_editor();
        }
    }

    fn generator_modal(&mut self, ctx: &Context) {
        let Some(g) = &mut self.generator else { return };
        let p = pal(ctx);
        let mut close = false;
        let mut copy = None;
        egui::Modal::new(Id::unique("generator"))
            .frame(Self::modal_frame(&p))
            .backdrop_color(Color32::from_black_alpha(140))
            .show(ctx, |ui| {
                ui.set_width(460.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Générateur de mot de passe").font(semibold(19.0)));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if theme::icon_button(ui, Icon::Close, "Fermer (Échap)").clicked() {
                            close = true;
                        }
                    });
                });
                ui.add_space(12.0);
                theme::card(&p).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.set_max_width(ui.available_width() - 76.0);
                            ui.add(egui::Label::new(RichText::new(g.value.as_str()).font(FontId::monospace(17.0))).wrap());
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if theme::icon_button(ui, Icon::Copy, "Copier").clicked() {
                                copy = Some(g.value.clone());
                            }
                            if theme::icon_button(ui, Icon::Refresh, "Régénérer").clicked() {
                                g.value = Zeroizing::new(util::generate_password(&self.gen_opts));
                            }
                        });
                    });
                });
                ui.add_space(6.0);
                strength_bar(ui, &self.gen_opts);
                ui.add_space(10.0);
                if gen_controls(ui, &mut self.gen_opts) {
                    g.value = Zeroizing::new(util::generate_password(&self.gen_opts));
                }
                ui.add_space(14.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui.add(Btn::primary("Copier").icon(Icon::Copy)).clicked() {
                        copy = Some(g.value.clone());
                    }
                    if ui.add(Btn::new("Régénérer").icon(Icon::Refresh)).clicked() {
                        g.value = Zeroizing::new(util::generate_password(&self.gen_opts));
                    }
                });
            });
        if let Some(v) = copy {
            self.copy(&v, "Mot de passe");
        }
        if close {
            self.generator = None;
        }
    }

    fn confirm_modal(&mut self, ctx: &Context) {
        let Some(id) = self.confirm_delete.clone() else { return };
        let name = self.vault.items.get(&id).map(|i| i.name().to_string()).unwrap_or_default();
        let p = pal(ctx);
        let mut confirm = false;
        let mut cancel = false;
        egui::Modal::new(Id::unique("confirm"))
            .frame(Self::modal_frame(&p))
            .backdrop_color(Color32::from_black_alpha(140))
            .show(ctx, |ui| {
                ui.set_width(380.0);
                ui.horizontal(|ui| {
                    let (r, _) = ui.allocate_exact_size(vec2(40.0, 40.0), Sense::hover());
                    ui.painter().rect_filled(r, CornerRadius::same(12), alpha(p.danger, 0.15));
                    theme::paint_icon(ui.painter(), egui::Rect::from_center_size(r.center(), vec2(20.0, 20.0)), Icon::Trash, p.danger);
                    ui.add_space(6.0);
                    ui.label(RichText::new("Supprimer l'entrée ?").font(semibold(18.0)));
                });
                ui.add_space(10.0);
                ui.label(RichText::new(format!("« {name} » sera supprimée de tous vos appareils.")).color(p.muted));
                ui.add_space(18.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if self.busy.is_some() {
                        busy_row(ui, "Suppression…");
                    } else {
                        if ui.add(Btn::new("Supprimer").icon(Icon::Trash).kind(Kind::Danger)).clicked() {
                            confirm = true;
                        }
                        if ui.add(Btn::new("Annuler")).clicked() {
                            cancel = true;
                        }
                    }
                });
            });
        if cancel {
            self.confirm_delete = None;
        }
        if confirm {
            self.confirm_delete = None;
            self.start_save(vec![Change::Delete(id)], SaveKind::Delete);
        }
    }

    fn settings_modal(&mut self, ctx: &Context) {
        if !self.show_settings {
            return;
        }
        let p = pal(ctx);
        let mut close = false;
        let mut changed = false;
        let path = self.sessions.path.display().to_string();
        egui::Modal::new(Id::unique("settings"))
            .frame(Self::modal_frame(&p))
            .backdrop_color(Color32::from_black_alpha(140))
            .show(ctx, |ui| {
                ui.set_width(480.0_f32.min(ctx.content_rect().width() - 80.0));
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Réglages").font(semibold(19.0)));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if theme::icon_button(ui, Icon::Close, "Fermer (Échap)").clicked() {
                            close = true;
                        }
                    });
                });
                ui.add_space(14.0);

                theme::label(ui, "Effacer le presse-papiers après une copie");
                ui.horizontal_wrapped(|ui| {
                    for c in ClipboardClear::ALL {
                        if choice_chip(ui, self.settings.clipboard_clear == c, c.label()) {
                            self.settings.clipboard_clear = c;
                            changed = true;
                        }
                    }
                });
                ui.label(
                    RichText::new("Si activé, le presse-papiers n'est vidé que s'il contient encore la valeur copiée.")
                        .size(12.5)
                        .color(p.muted),
                );
                ui.add_space(16.0);

                theme::label(ui, "Rester déverrouillé");
                ui.horizontal_wrapped(|ui| {
                    for s in StayUnlocked::ALL {
                        if choice_chip(ui, self.settings.stay_unlocked == s, s.label()) {
                            self.settings.stay_unlocked = s;
                            changed = true;
                        }
                    }
                });
                let how_long = match self.settings.stay_unlocked {
                    StayUnlocked::Always => "sans limite de durée".to_string(),
                    s => format!("jusqu'à {} après la dernière utilisation", s.label()),
                };
                Frame::new()
                    .fill(theme::mix(p.panel, p.warn, 0.10))
                    .corner_radius(CornerRadius::same(10))
                    .inner_margin(Margin::symmetric(12, 10))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.label(
                            RichText::new(format!(
                                "Le coffre reste ouvert {how_long}, même si l'application est fermée puis relancée. \
                                 Pendant cette durée, la clé du coffre est conservée sur ce poste ({path}, lisible \
                                 seulement par votre compte) : toute personne ayant accès à votre session peut ouvrir \
                                 le coffre. « Verrouiller » (Ctrl+L) l'efface immédiatement."
                            ))
                            .size(12.5)
                            .color(p.text),
                        );
                    });
                ui.add_space(16.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui.add(Btn::primary("Fermer")).clicked() {
                        close = true;
                    }
                });
            });
        if changed {
            self.save_settings();
        }
        if close {
            self.show_settings = false;
        }
    }

    fn toast_ui(&mut self, ctx: &Context) {
        let Some(t) = &self.toast else { return };
        let age = t.at.elapsed();
        let dur = if t.error { TOAST * 2 } else { TOAST };
        if age > dur {
            self.toast = None;
            return;
        }
        let fade = ((dur - age).as_secs_f32() / 0.3).min(1.0).min(age.as_secs_f32() / 0.15);
        let p = pal(ctx);
        egui::Area::new(Id::unique("toast"))
            .anchor(Align2::CENTER_BOTTOM, vec2(0.0, -24.0))
            .order(egui::Order::Tooltip)
            .interactable(false)
            .show(ctx, |ui| {
                ui.set_opacity(fade);
                let (fill, fg) = if p.dark { (Color32::from_rgb(0x26, 0x2b, 0x36), p.text) } else { (Color32::from_rgb(0x11, 0x18, 0x27), Color32::WHITE) };
                Frame::new()
                    .fill(fill)
                    .stroke(Stroke::new(1.0, if t.error { alpha(p.danger, 0.7) } else { alpha(p.border, 0.8) }))
                    .corner_radius(CornerRadius::same(12))
                    .inner_margin(Margin::symmetric(16, 10))
                    .shadow(egui::Shadow { offset: [0, 8], blur: 24, spread: 0, color: Color32::from_black_alpha(90) })
                    .show(ui, |ui| {
                        ui.set_max_width(520.0);
                        ui.horizontal(|ui| {
                            let (r, _) = ui.allocate_exact_size(vec2(16.0, 16.0), Sense::hover());
                            if t.error {
                                theme::paint_icon(ui.painter(), r, Icon::Close, p.danger);
                            } else {
                                theme::paint_icon(ui.painter(), r, Icon::Check, p.success);
                            }
                            ui.add(egui::Label::new(RichText::new(&t.text).color(fg).size(13.5)).wrap());
                        });
                    });
            });
        ctx.request_repaint_after(Duration::from_millis(50));
    }
}

impl eframe::App for App {
    fn logic(&mut self, ctx: &Context, _frame: &mut eframe::Frame) {
        self.handle_messages();
        if self.screen == Screen::Main {
            if self.deadline.is_some_and(|d| now_ms() >= d) {
                let label = self.settings.stay_unlocked.label();
                self.lock(Some(format!("Verrouillé après {label} d'inactivité")));
            } else if self.last_sync.elapsed() >= SYNC_EVERY {
                self.start_sync(false);
            }
        }
        if let Some((_, at)) = &self.clip {
            match self.settings.clipboard_clear.secs() {
                Some(secs) if at.elapsed() >= Duration::from_secs(secs) => self.clear_clipboard_if_ours(),
                None => self.clip = None, // réglage passé à « Jamais » : on ne touche plus au presse-papiers
                _ => {}
            }
        }
        if self.screen == Screen::Main || self.clip.is_some() {
            ctx.request_repaint_after(Duration::from_secs(1));
        }
    }

    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        if ctx.input(|i| !i.events.is_empty() || i.pointer.delta() != egui::Vec2::ZERO) {
            self.touch_session();
        }
        let p = pal(&ctx);
        match self.screen {
            Screen::Main => self.ui_main(ui),
            screen => {
                egui::CentralPanel::default().frame(Frame::new().fill(p.bg)).show(ui, |ui| {
                    if screen == Screen::Setup {
                        self.ui_setup(ui)
                    } else {
                        self.ui_unlock(ui)
                    }
                });
            }
        }
        self.toast_ui(&ctx);
    }
}

impl Drop for App {
    fn drop(&mut self) {
        self.clear_clipboard_if_ours();
        // Fermeture : la session persistante est conservée (échéance à jour), pas effacée.
        if self.screen == Screen::Main && self.vault.unlocked() {
            self.persist_session();
        }
        self.vault.lock();
    }
}

// ------------------------------------------------------------------ icônes

/// Texture de l'icône du site d'une entrée, décodée et chargée au premier affichage seulement.
/// L'image et sa silhouette blanche (contour selon `iconTone`) sont créées ensemble.
fn icon_texture(icons: &mut HashMap<u64, Option<theme::SiteIcon>>, ctx: &Context, it: &Item) -> Option<theme::SiteIcon> {
    let key = it.icon_key?;
    icons
        .entry(key)
        .or_insert_with(|| {
            biopass::icon::decode_icon(it.str("icon")).map(|img| {
                let size = [img.width as usize, img.height as usize];
                let opts = egui::TextureOptions::LINEAR;
                let image = egui::ColorImage::from_rgba_unmultiplied(size, &img.pixels);
                let silhouette: Vec<u8> = img.pixels.as_chunks::<4>().0.iter().flat_map(|p| [255, 255, 255, p[3]]).collect();
                let mask = egui::ColorImage::from_rgba_unmultiplied(size, &silhouette);
                theme::SiteIcon {
                    img: ctx.load_texture(format!("icone-{key:016x}"), image, opts),
                    mask: ctx.load_texture(format!("icone-{key:016x}-m"), mask, opts),
                }
            })
        })
        .clone()
}

// ------------------------------------------------------------------ validation

/// Longueur minimale du mot de passe maître à la création d'un compte.
const MIN_MASTER_LEN: usize = 5;

/// Erreur de saisie de l'écran de configuration, ou None si le formulaire est valide.
fn setup_error(f: &SetupForm, server_ok: bool, user: &str) -> Option<&'static str> {
    if f.server.trim().is_empty() {
        Some("Indiquez l'adresse du serveur")
    } else if !server_ok {
        Some("Adresse du serveur invalide")
    } else if user.is_empty() {
        Some("Indiquez votre identifiant")
    } else if f.password.is_empty() {
        Some("Indiquez votre mot de passe")
    } else if f.create && f.password.chars().count() < MIN_MASTER_LEN {
        Some("Le mot de passe maître doit faire au moins 5 caractères")
    } else if f.create && f.password != f.confirm {
        Some("Les deux mots de passe ne correspondent pas")
    } else if f.create && f.code.trim().is_empty() {
        Some("Indiquez le code d'inscription")
    } else {
        None
    }
}

// ------------------------------------------------------------------ fragments d'UI

fn input(ui: &mut Ui, label: &str, value: &mut String, hint: &str, password: bool, width: Option<f32>) -> egui::Response {
    theme::label(ui, label);
    let r = ui.add(
        TextEdit::singleline(value)
            .password(password)
            .hint_text(hint)
            .desired_width(width.unwrap_or(f32::INFINITY))
            .margin(Margin::symmetric(10, 8))
            .font(FontId::proportional(14.5)),
    );
    ui.add_space(6.0);
    r
}

fn enter_pressed(ui: &Ui, r: &egui::Response) -> bool {
    r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter))
}

fn busy_row(ui: &mut Ui, text: &str) {
    let p = pal(ui.ctx());
    ui.horizontal(|ui| {
        ui.set_min_height(42.0);
        theme::dots(ui);
        ui.label(RichText::new(text).color(p.muted));
    });
}

/// Galerie de texte tronquée sur une ligne avec « … ».
fn truncated(ui: &Ui, text: &str, font: FontId, color: Color32, width: f32) -> std::sync::Arc<egui::Galley> {
    let mut job = LayoutJob::simple_singleline(text.to_string(), font, color);
    job.wrap = egui::text::TextWrapping { max_width: width, max_rows: 1, break_anywhere: true, overflow_character: Some('…') };
    ui.painter().layout_job(job)
}

fn subtitle(it: &Item) -> String {
    let u = it.str("username");
    if !u.is_empty() {
        return u.to_string();
    }
    if let Some(h) = get_uris(&it.data).iter().map(|u| util::host_of(u)).find(|h| !h.is_empty()) {
        return h;
    }
    if it.str("type") == "note" {
        return "Note".into();
    }
    it.str("folder").to_string()
}

fn group_code(code: &str) -> String {
    let mid = code.len() / 2;
    if code.len() >= 6 {
        format!("{} {}", &code[..mid], &code[mid..])
    } else {
        code.to_string()
    }
}

/// Date (UTC) jj/mm/aaaa depuis un horodatage en ms.
fn fmt_date(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{d:02}/{m:02}/{y}")
}

fn masked(s: &str) -> String {
    "•".repeat(s.chars().count().clamp(8, 24))
}

fn copy_icon(ds: &DetailState, key: &str) -> Icon {
    match &ds.copied {
        Some((k, at)) if k == key && at.elapsed() < Duration::from_millis(1500) => Icon::Check,
        _ => Icon::Copy,
    }
}

/// Carte d'un champ : libellé, valeur, boutons à droite.
fn field_card(ui: &mut Ui, p: &Pal, label: &str, value: impl FnOnce(&mut Ui), buttons: impl FnOnce(&mut Ui)) {
    theme::card(p).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.set_max_width((ui.available_width() - 120.0).max(80.0));
                theme::label(ui, label);
                ui.add_space(1.0);
                value(ui);
            });
            ui.with_layout(Layout::right_to_left(Align::Center), buttons);
        });
    });
    ui.add_space(4.0);
}

fn detail_ui(ui: &mut Ui, it: &Item, site: Option<&theme::SiteIcon>, ds: &DetailState, can_edit: bool) -> Vec<Action> {
    let p = pal(ui.ctx());
    let mut out = Vec::new();
    let copy = |out: &mut Vec<Action>, text: &str, what: &str, key: &str| {
        out.push(Action::Copy { text: Zeroizing::new(text.to_string()), what: what.into(), key: key.into() })
    };
    ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
        ui.set_max_width(ui.available_width().min(760.0));
        // en-tête
        ui.horizontal(|ui| {
            theme::avatar_icon(ui, 56.0, it.name(), it.kind, site.map(|s| (s, it.str("iconTone"))));
            ui.add_space(6.0);
            ui.vertical(|ui| {
                ui.set_max_width((ui.available_width() - 240.0).max(120.0));
                ui.add_space(4.0);
                let name = if it.name().is_empty() { "(sans nom)" } else { it.name() };
                ui.add(egui::Label::new(RichText::new(name).font(semibold(22.0))).truncate());
                ui.horizontal(|ui| {
                    let folder = it.str("folder");
                    if !folder.is_empty() {
                        chip(ui, folder, p.accent_hi);
                    }
                    if it.str("type") == "note" {
                        chip(ui, "Note", p.muted);
                    }
                    if let Some(h) = get_uris(&it.data).first().map(|u| util::base_domain(&util::host_of(u))).filter(|h| !h.is_empty()) {
                        ui.label(RichText::new(h).size(13.0).color(p.muted));
                    }
                });
            });
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.add_enabled_ui(can_edit, |ui| {
                    let tip = if can_edit { "" } else { "Hors ligne : lecture seule" };
                    let r = ui.add(Btn::new("").icon(Icon::Trash).kind(Kind::Ghost).width(36.0));
                    if r.clicked() {
                        out.push(Action::Delete);
                    }
                    r.on_hover_text(if can_edit { "Supprimer" } else { tip });
                    let r = ui.add(Btn::new("Modifier").icon(Icon::Edit));
                    if r.clicked() {
                        out.push(Action::Edit);
                    }
                    if !can_edit {
                        r.on_disabled_hover_text(tip);
                    }
                    let fav = it.fav();
                    let star = if fav { Icon::StarFilled } else { Icon::Star };
                    let col = if fav { Some(p.warn) } else { None };
                    if theme::icon_button_colored(ui, star, if fav { "Retirer des favoris" } else { "Ajouter aux favoris" }, col).clicked() {
                        out.push(Action::ToggleFav);
                    }
                });
            });
        });
        ui.add_space(18.0);

        let username = it.str("username");
        if !username.is_empty() {
            field_card(
                ui,
                &p,
                "Identifiant",
                |ui| {
                    ui.add(egui::Label::new(RichText::new(username).size(15.0)).wrap());
                },
                |ui| {
                    if theme::icon_button(ui, copy_icon(ds, "username"), "Copier l'identifiant (Ctrl+U)").clicked() {
                        copy(&mut out, username, "Identifiant", "username");
                    }
                },
            );
        }

        let password = it.str("password");
        if !password.is_empty() {
            field_card(
                ui,
                &p,
                "Mot de passe",
                |ui| {
                    let shown = if ds.show_password { password.to_string() } else { masked(password) };
                    ui.add(egui::Label::new(RichText::new(shown).font(FontId::monospace(15.0))).wrap());
                },
                |ui| {
                    if theme::icon_button(ui, copy_icon(ds, "password"), "Copier le mot de passe (Entrée)").clicked() {
                        copy(&mut out, password, "Mot de passe", "password");
                    }
                    let (icon, tip) = if ds.show_password { (Icon::EyeOff, "Masquer") } else { (Icon::Eye, "Afficher") };
                    if theme::icon_button(ui, icon, tip).clicked() {
                        out.push(Action::TogglePassword);
                    }
                },
            );
        }

        let hist = biopass::model::history(&it.data);
        if !hist.is_empty() {
            theme::card(&p).show(ui, |ui| {
                ui.set_width(ui.available_width());
                let header = ui.horizontal(|ui| {
                    let (r, _) = ui.allocate_exact_size(vec2(12.0, 12.0), Sense::hover());
                    let c = r.center();
                    let pts = if ds.history_open {
                        vec![c + vec2(-4.0, -2.0), c + vec2(0.0, 2.5), c + vec2(4.0, -2.0)]
                    } else {
                        vec![c + vec2(-2.0, -4.0), c + vec2(2.5, 0.0), c + vec2(-2.0, 4.0)]
                    };
                    ui.painter().add(egui::Shape::line(pts, Stroke::new(1.6, p.muted)));
                    theme::label(ui, &format!("Historique des mots de passe ({})", hist.len()));
                    ui.allocate_space(vec2(ui.available_width(), 1.0));
                });
                let hr = ui.interact(header.response.rect, ui.scope_id().with("hist-toggle"), Sense::click());
                if hr.hovered() {
                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                }
                hr.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, "Historique des mots de passe"));
                if hr.on_hover_text(if ds.history_open { "Replier" } else { "Déplier" }).clicked() {
                    out.push(Action::ToggleHistory);
                }
                if ds.history_open {
                    for (i, (pw, date)) in hist.iter().enumerate() {
                        ui.separator();
                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.set_max_width((ui.available_width() - 80.0).max(80.0));
                                let shown = ds.revealed_hist.contains(&i);
                                let txt = if shown { pw.to_string() } else { masked(pw) };
                                ui.add(egui::Label::new(RichText::new(txt).font(FontId::monospace(14.0))).wrap());
                                let when = if *date > 0 { format!("Remplacé le {}", fmt_date(*date)) } else { "Date inconnue".into() };
                                ui.label(RichText::new(when).size(12.0).color(p.muted));
                            });
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                let key = format!("hist:{i}");
                                if theme::icon_button(ui, copy_icon(ds, &key), "Copier cet ancien mot de passe").clicked() {
                                    copy(&mut out, pw, "Ancien mot de passe", &key);
                                }
                                let shown = ds.revealed_hist.contains(&i);
                                let (icon, tip) = if shown { (Icon::EyeOff, "Masquer") } else { (Icon::Eye, "Afficher") };
                                if theme::icon_button(ui, icon, tip).clicked() {
                                    out.push(Action::RevealHistory(i));
                                }
                            });
                        });
                    }
                }
            });
            ui.add_space(4.0);
        }

        let totp_s = it.str("totp");
        if !totp_s.trim().is_empty() {
            let t = util::totp(totp_s, now_ms());
            field_card(
                ui,
                &p,
                "Code à usage unique (TOTP)",
                |ui| match &t {
                    Some(t) => {
                        ui.label(RichText::new(group_code(&t.code)).font(FontId::monospace(22.0)).color(if t.remaining <= 5 { p.danger } else { p.accent_hi }));
                    }
                    None => {
                        ui.label(RichText::new("Secret TOTP invalide").color(p.danger));
                    }
                },
                |ui| {
                    if let Some(t) = &t {
                        if theme::icon_button(ui, copy_icon(ds, "totp"), "Copier le code (Ctrl+T)").clicked() {
                            copy(&mut out, &t.code, "Code TOTP", "totp");
                        }
                        theme::countdown(ui, t.remaining, t.period).on_hover_text(format!("Expire dans {} s", t.remaining));
                    }
                },
            );
        }

        let uris = get_uris(&it.data);
        if !uris.is_empty() {
            theme::card(&p).show(ui, |ui| {
                ui.set_width(ui.available_width());
                theme::label(ui, if uris.len() > 1 { "Sites" } else { "Site" });
                for (i, u) in uris.iter().enumerate() {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.set_max_width((ui.available_width() - 80.0).max(80.0));
                            let full = if u.contains("://") { u.to_string() } else { format!("https://{u}") };
                            let r = ui.add(egui::Label::new(RichText::new(*u).color(p.accent_hi).size(14.5)).sense(Sense::click()).truncate());
                            if r.hovered() {
                                ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                            }
                            if r.on_hover_text(format!("Ouvrir {full}")).clicked() {
                                out.push(Action::Open(full));
                            }
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let key = format!("uri:{i}");
                            if theme::icon_button(ui, copy_icon(ds, &key), "Copier l'adresse").clicked() {
                                copy(&mut out, u, "Adresse", &key);
                            }
                            if theme::icon_button(ui, Icon::External, "Ouvrir dans le navigateur").clicked() {
                                let full = if u.contains("://") { u.to_string() } else { format!("https://{u}") };
                                out.push(Action::Open(full));
                            }
                        });
                    });
                }
            });
            ui.add_space(4.0);
        }

        if let Some(fields) = it.data.get("fields").and_then(|f| f.as_array()) {
            for (i, f) in fields.iter().enumerate() {
                let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let value = match f.get("value") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Null) | None => String::new(),
                    Some(v) => v.to_string(),
                };
                let value = Zeroizing::new(value);
                let hidden = f.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
                let shown = !hidden || ds.revealed.contains(&i);
                field_card(
                    ui,
                    &p,
                    if name.is_empty() { "Champ" } else { name },
                    |ui| {
                        let txt = if shown { value.to_string() } else { masked(&value) };
                        let font = if hidden { FontId::monospace(15.0) } else { FontId::proportional(15.0) };
                        ui.add(egui::Label::new(RichText::new(txt).font(font)).wrap());
                    },
                    |ui| {
                        let key = format!("field:{i}");
                        if theme::icon_button(ui, copy_icon(ds, &key), "Copier").clicked() {
                            copy(&mut out, &value, if name.is_empty() { "Champ" } else { name }, &key);
                        }
                        if hidden {
                            let (icon, tip) = if shown { (Icon::EyeOff, "Masquer") } else { (Icon::Eye, "Afficher") };
                            if theme::icon_button(ui, icon, tip).clicked() {
                                out.push(Action::Reveal(i));
                            }
                        }
                    },
                );
            }
        }

        let notes = it.str("notes");
        if !notes.trim().is_empty() {
            theme::card(&p).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    theme::label(ui, "Notes");
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if theme::icon_button(ui, copy_icon(ds, "notes"), "Copier les notes").clicked() {
                            copy(&mut out, notes, "Notes", "notes");
                        }
                    });
                });
                ui.add(egui::Label::new(RichText::new(notes).size(14.5)).wrap().selectable(true));
            });
            ui.add_space(4.0);
        }

        // pied : dates
        let date = |k: &str| it.data.get(k).and_then(|v| v.as_u64()).filter(|&v| v > 0).map(fmt_date);
        let mut meta = Vec::new();
        if let Some(d) = date("created") {
            meta.push(format!("Créée le {d}"));
        }
        if let Some(d) = date("updated") {
            meta.push(format!("modifiée le {d}"));
        }
        if !meta.is_empty() {
            ui.add_space(8.0);
            ui.label(RichText::new(meta.join(" · ")).size(12.0).color(p.muted));
        }
    });
    out
}

fn chip(ui: &mut Ui, text: &str, color: Color32) {
    let galley = ui.painter().layout_no_wrap(text.to_string(), semibold(11.5), color);
    let (rect, _) = ui.allocate_exact_size(galley.size() + vec2(16.0, 6.0), Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius::same(10), alpha(color, 0.15));
    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, color);
}

fn empty_state(ui: &mut Ui) {
    let p = pal(ui.ctx());
    ui.vertical_centered(|ui| {
        ui.add_space((ui.available_height() / 2.0 - 190.0).max(20.0));
        theme::logo(ui, 56.0);
        ui.add_space(12.0);
        ui.label(RichText::new("Sélectionnez une entrée").font(semibold(18.0)));
        ui.label(RichText::new("ou tapez pour rechercher").color(p.muted));
        ui.add_space(18.0);
        let rows: &[(&str, &str)] = &[
            ("↑ ↓", "naviguer dans la liste"),
            ("Entrée", "copier le mot de passe"),
            ("Ctrl U", "copier l'identifiant"),
            ("Ctrl T", "copier le code TOTP"),
            ("Ctrl N", "nouvelle entrée"),
            ("Ctrl L", "verrouiller"),
            ("Échap", "effacer la recherche"),
        ];
        Frame::new().fill(p.panel).stroke(Stroke::new(1.0, p.border)).corner_radius(CornerRadius::same(12)).inner_margin(Margin::symmetric(18, 14)).show(
            ui,
            |ui| {
                ui.set_width(300.0);
                for (k, d) in rows {
                    ui.horizontal(|ui| {
                        ui.allocate_ui_with_layout(vec2(90.0, 24.0), Layout::left_to_right(Align::Center), |ui| {
                            for part in k.split(' ') {
                                keycap(ui, part);
                            }
                        });
                        ui.label(RichText::new(*d).size(13.5).color(p.muted));
                    });
                }
            },
        );
    });
}

fn keycap(ui: &mut Ui, k: &str) {
    let p = pal(ui.ctx());
    let galley = ui.painter().layout_no_wrap(k.to_string(), semibold(11.5), p.text);
    let w = (galley.size().x + 12.0).max(22.0);
    let (rect, _) = ui.allocate_exact_size(vec2(w, 22.0), Sense::hover());
    ui.painter().rect_filled(rect, CornerRadius::same(6), p.card);
    ui.painter().rect_stroke(rect, CornerRadius::same(6), Stroke::new(1.0, p.border), StrokeKind::Inside);
    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, p.text);
}

/// Réglages du générateur ; renvoie true si une option a changé.
fn gen_controls(ui: &mut Ui, o: &mut GenOptions) -> bool {
    let p = pal(ui.ctx());
    let before = *o;
    ui.horizontal(|ui| {
        ui.label(RichText::new("Longueur").color(p.muted));
        let mut len = o.length as u32;
        ui.spacing_mut().slider_width = (ui.available_width() - 70.0).max(80.0);
        ui.add(egui::Slider::new(&mut len, 8..=64));
        o.length = len as usize;
    });
    ui.horizontal_wrapped(|ui| {
        toggle_chip(ui, &mut o.lower, "a–z");
        toggle_chip(ui, &mut o.upper, "A–Z");
        toggle_chip(ui, &mut o.digits, "2–9");
        toggle_chip(ui, &mut o.symbols, "!@#$");
    });
    *o != before
}

/// Pastille de choix exclusif ; renvoie true si cliquée.
fn choice_chip(ui: &mut Ui, selected: bool, text: &str) -> bool {
    let p = pal(ui.ctx());
    let col = if selected { p.accent_hi } else { p.text };
    let galley = ui.painter().layout_no_wrap(text.to_string(), semibold(13.0), col);
    let (rect, resp) = ui.allocate_exact_size(galley.size() + vec2(28.0, 14.0), Sense::click());
    let cr = CornerRadius::same(15);
    let fill = if selected { alpha(p.accent, 0.18) } else if resp.hovered() { p.hover } else { p.card };
    ui.painter().rect_filled(rect, cr, fill);
    ui.painter().rect_stroke(rect, cr, Stroke::new(1.0, if selected { alpha(p.accent, 0.7) } else { p.border }), StrokeKind::Inside);
    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, col);
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let label = text.to_string();
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::RadioButton, true, &label));
    resp.clicked()
}

fn toggle_chip(ui: &mut Ui, on: &mut bool, text: &str) {
    let p = pal(ui.ctx());
    let col = if *on { p.accent_hi } else { p.muted };
    let galley = ui.painter().layout_no_wrap(text.to_string(), semibold(13.0), col);
    let (rect, resp) = ui.allocate_exact_size(galley.size() + vec2(36.0, 14.0), Sense::click());
    let cr = CornerRadius::same(15);
    ui.painter().rect_filled(rect, cr, if *on { alpha(p.accent, 0.16) } else { p.card });
    ui.painter().rect_stroke(rect, cr, Stroke::new(1.0, if *on { alpha(p.accent, 0.6) } else { p.border }), StrokeKind::Inside);
    let ir = egui::Rect::from_center_size(pos2(rect.left() + 15.0, rect.center().y), vec2(12.0, 12.0));
    if *on {
        theme::paint_icon(ui.painter(), ir, Icon::Check, col);
    } else {
        ui.painter().circle_stroke(ir.center(), 4.5, Stroke::new(1.2, col));
    }
    ui.painter().galley(pos2(rect.left() + 26.0, rect.center().y - galley.size().y / 2.0), galley, col);
    if resp.clicked() {
        *on = !*on;
    }
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
}

/// Barre de robustesse estimée (entropie = longueur × log2(alphabet)).
fn strength_bar(ui: &mut Ui, o: &GenOptions) {
    let p = pal(ui.ctx());
    let n: usize = [(o.lower, 25), (o.upper, 24), (o.digits, 8), (o.symbols, 15)].iter().filter(|x| x.0).map(|x| x.1).sum::<usize>().max(25);
    let bits = o.length as f32 * (n as f32).log2();
    let (label, col, frac) = match bits as u32 {
        0..=49 => ("Faible", p.danger, 0.25),
        50..=79 => ("Moyen", p.warn, 0.5),
        80..=119 => ("Fort", p.success, 0.78),
        _ => ("Très fort", p.success, 1.0),
    };
    ui.horizontal(|ui| {
        let w = ui.available_width() - 150.0;
        let (rect, _) = ui.allocate_exact_size(vec2(w, 6.0), Sense::hover());
        ui.painter().rect_filled(rect, CornerRadius::same(3), p.border);
        let mut fill = rect;
        fill.set_width(rect.width() * frac);
        ui.painter().rect_filled(fill, CornerRadius::same(3), col);
        ui.label(RichText::new(format!("{label} · {} bits", bits as u32)).size(12.5).color(col));
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn date() {
        assert_eq!(super::fmt_date(0), "01/01/1970");
        assert_eq!(super::fmt_date(1_730_000_000_000), "27/10/2024");
        assert_eq!(super::group_code("123456"), "123 456");
    }

    #[test]
    fn master_password_min_length() {
        use super::{setup_error, SetupForm};
        let form = |pw: &str, create: bool| SetupForm {
            server: "https://x.fr".into(),
            user: "camille".into(),
            password: pw.into(),
            confirm: pw.into(),
            create,
            code: "famille".into(),
        };
        let msg = Some("Le mot de passe maître doit faire au moins 5 caractères");
        assert_eq!(setup_error(&form("abcd", true), true, "camille"), msg);
        assert_eq!(setup_error(&form("crème", true), true, "camille"), None, "5 caractères (et non 6 octets) suffisent");
        assert_eq!(setup_error(&form("abcde", true), true, "camille"), None);
        // La longueur n'est pas contrôlée à la simple connexion.
        assert_eq!(setup_error(&form("abc", false), true, "camille"), None);
        let mut f = form("abcdef", true);
        f.confirm = "autre".into();
        assert_eq!(setup_error(&f, true, "camille"), Some("Les deux mots de passe ne correspondent pas"));
    }
}
