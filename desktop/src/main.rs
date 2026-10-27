// BioPass — application de bureau. Pas de console sous Windows en release.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod app;
mod theme;

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("BioPass")
            .with_app_id("biopass")
            .with_inner_size([920.0, 640.0])
            .with_min_inner_size([720.0, 480.0])
            .with_icon(theme::window_icon(64)),
        // Centrée au lancement (X11, Windows, macOS). Sous Wayland, c'est le compositeur qui place
        // les fenêtres : voir la règle Hyprland du README (app_id « biopass »).
        centered: true,
        ..Default::default()
    };
    eframe::run_native("BioPass", options, Box::new(|cc| Ok(Box::new(app::App::new(cc)))))
}
