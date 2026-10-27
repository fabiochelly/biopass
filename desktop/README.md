# BioPass — application de bureau

Client natif (Rust + egui) du gestionnaire de mots de passe familial BioPass.
Binaire unique, démarrage immédiat, Linux / Windows / macOS. Implémente le protocole
de `../PROTOCOL.md`, avec le même comportement que `server/web/assets/core.js`.

## Compilation

```sh
cargo build --release          # → target/release/biopass
```

Aucune bibliothèque système n'est nécessaire à la compilation sous Linux
(X11, Wayland et OpenGL sont chargés dynamiquement à l'exécution).

Windows, en compilation croisée depuis Linux : `cargo build --release --target x86_64-pc-windows-gnu`
(il faut installer la cible avec `rustup target add x86_64-pc-windows-gnu` et la chaîne mingw-w64).
Le plus simple reste de compiler directement sous Windows ou macOS avec `cargo build --release`.

## Utilisation

1. Premier lancement : adresse du serveur, identifiant, mot de passe maître. Si le serveur
   est protégé par une clé d'accès, collez l'adresse complète fournie (ex.
   `https://exemple.fr/biopass/?k=<clé>`) : la clé est envoyée dans l'en-tête `X-BP-Key`,
   enregistrée dans le profil local et **jamais affichée** (seule la base l'est ; si vous
   ressaisissez la même base sans `?k=`, la clé connue est réutilisée). Cochez « Créer un compte » et saisissez le code d'inscription
   pour créer un nouveau compte.
2. Ensuite : seul le mot de passe maître est demandé (« Changer d'utilisateur » pour un autre compte).
3. Si le serveur est injoignable, le coffre s'ouvre en **lecture seule** depuis le cache local ;
   la reconnexion est retentée automatiquement (toutes les 5 minutes, ou bouton Synchroniser).

La recherche est approximative (fautes de frappe, lettres manquantes, accents ignorés) et
reproduit exactement celle des autres clients (`PROTOCOL.md` § 5, testée sur `tools/search-vectors.json`).

Les icônes des sites (champ `icon`, récupérées par le site web et l'extension) sont affichées
brutes dans la liste et le détail (logo très sombre en thème sombre : pastille blanche, selon `iconTone`) ; chacune est décodée une
seule fois. Sans icône, une tuile de catégorie (réseau, terminal, Wi-Fi, carte, clé, appli, note —
même logique que `entryKind` de core.js) ou l'initiale. Si l'adresse du site change à
l'édition, l'icône est oubliée pour être récupérée à nouveau.

Synchronisation automatique au déverrouillage puis toutes les 5 minutes.

### Réglages (icône engrenage)

- **Rester déverrouillé** : 5 min, 1 h, 8 h, 48 h (défaut), Toujours, comptés depuis la dernière
  utilisation, **même si l'application est fermée puis relancée**. Pendant ce temps, la clé du coffre
  et la clé d'authentification sont conservées sur ce poste dans `session.json` (permissions 0600) ;
  au lancement, le coffre s'ouvre sans mot de passe puis l'app se reconnecte en arrière-plan
  (si le mot de passe a changé ailleurs, il est redemandé). **Verrouiller** (bouton ou Ctrl+L)
  efface ce fichier.

Les réglages sont dans `settings.json`, à côté du cache.

### Fenêtre

Taille initiale 920×640, minimale 720×480 ; sous 860 px de large, une seule colonne (liste, puis
détail de l'entrée ouverte ; Échap ou « Liste » pour revenir). La fenêtre est centrée au lancement
sous X11, Windows et macOS ; sous Wayland, c'est le compositeur qui place les fenêtres. Exemple pour
Hyprland (`app_id` = `biopass`, syntaxe à adapter à votre version) :

```
windowrule = float, class:^(biopass)$
windowrule = center, class:^(biopass)$
windowrule = size 920 640, class:^(biopass)$
```

## Raccourcis

| Touche | Action |
|---|---|
| (frappe) | recherche |
| ↑ / ↓ | naviguer dans la liste |
| Entrée | copier le mot de passe |
| Ctrl+U | copier l'identifiant |
| Ctrl+T | copier le code TOTP |
| Ctrl+N | nouvelle entrée |
| Ctrl+L | verrouiller |
| Échap | effacer la recherche (puis la sélection) |
| Ctrl+S / Échap | dans l'éditeur : enregistrer / annuler |

Sous macOS, Ctrl est remplacé par Cmd. Double-clic sur une entrée = copier le mot de passe.

## Cache local

`<données utilisateur>/biopass/cache.json` :

- Linux : `~/.local/share/biopass/cache.json`
- Windows : `%APPDATA%\biopass\cache.json`
- macOS : `~/Library/Application Support/biopass/cache.json`

`session.json` (session persistante, voir Réglages) et `settings.json` sont dans le même dossier.

Le cache ne contient que des données chiffrées (`{profile:{server,user,salt,iter,wrapped}, vault:{rev, items}}`),
jamais le token ni aucune donnée en clair. `server` y est stocké sous forme normalisée, clé d'accès comprise. Écriture atomique, permissions 0600 sous Unix.
La variable `BIOPASS_DATA_DIR` permet d'utiliser un autre dossier.

## Tests

```sh
cargo test                     # vecteurs de test (tools/test-vectors.json), TOTP, recherche…

# Intégration contre un vrai serveur PHP (code d'inscription « famille », access_key « cle-test »,
# lancé en mode routeur : php -S 127.0.0.1:8781 -t srv) :
BIOPASS_TEST_SERVER='http://127.0.0.1:8781/?k=cle-test' cargo test --test server -- --ignored --test-threads=1
```

## Structure

- `src/crypto.rs` — PBKDF2/HKDF, AES-256-GCM, enveloppe de la clé du coffre, chiffrement des entrées
- `src/api.rs` — client HTTP (ureq, rustls)
- `src/vault.rs` — profil, cache, déverrouillage en ligne / hors ligne, synchronisation, enregistrement
- `src/util.rs` — recherche, domaines, TOTP, générateur
- `src/icon.rs` — décodage des icônes de sites (PNG en data URL)
- `src/session.rs` — réglages et session persistante (« Rester déverrouillé »)
- `src/model.rs` — formulaire d'édition (champs inconnus conservés), historique des mots de passe
- `src/app.rs`, `src/theme.rs` — interface egui
