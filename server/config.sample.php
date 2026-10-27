<?php
defined('BIOPASS') or require __DIR__ . '/src/404.php';
// ↑ Garde : NE PAS SUPPRIMER. Appelé directement depuis le web, ce fichier répond 404 au lieu de s'exécuter.
//
// BioPass — configuration du serveur
// ==================================
// 1. Copiez ce fichier en config.php (dans le même dossier) : cp config.sample.php config.php
// 2. Modifiez les réglages marqués [À MODIFIER]. Les autres ont des valeurs par défaut correctes.
// 3. Lancez tools/build-server.sh puis déployez le dossier server/ (sans web/ ni data/).
//
// config.php contient vos secrets : il n'est jamais versionné (voir .gitignore).
// Repères : [À MODIFIER] obligatoire · [CONSEILLÉ] recommandé · [OPTIONNEL] selon vos besoins · [AVANCÉ] à laisser tel quel.

return [

    // ------------------------------------------------------------------ accès

    // [À MODIFIER] Clé d'accès : un identifiant long et imprévisible. Générez-en un avec :
    //     cat /proc/sys/kernel/random/uuid        (Linux)      ou      uuidgen
    // Sans cette clé dans l'adresse (…/biopass/?k=<clé>), TOUT répond 404 : BioPass est invisible
    // pour les robots et les curieux. Les applications et l'extension reçoivent l'adresse complète
    // (affichée par le site, menu ☰ → Applications). Laisser '' désactive cette protection (déconseillé).
    'access_key' => '',

    // [À MODIFIER] Code à saisir pour créer un compte (à donner aux membres de la famille).
    // Une fois tous les comptes créés, remettez '' : les inscriptions sont alors fermées.
    'registration_code' => 'changez-moi',

    // [CONSEILLÉ] Adresse publique de BioPass, SANS la clé et sans / final.
    //     ex. 'https://example.com/biopass'
    // Nécessaire pour publier l'extension signée (.crx) qui s'installe et se met à jour toute seule
    // dans Brave / Chrome / Chromium sous Linux (script install-brave.sh, menu Applications du site).
    // Laisser '' : seule l'installation manuelle de l'extension (zip) est proposée.
    'public_url' => '',

    // [CONSEILLÉ] Réponse imitée pour l'adresse du dossier sans clé (…/biopass/), pour qu'elle soit
    // identique à celle de votre site pour n'importe quel dossier inexistant. Relevez-la avec :
    //     curl -si https://example.com/nexiste-pas/
    // puis recopiez les en-têtes utiles et le corps de la page. null = la page 404 standard de nginx
    // (les URL en .php, elles, répondent toujours le 404 nginx, comme un script inexistant).
    // Exemple :
    //     'not_found_page' => [
    //         'headers' => ['Content-Type: text/html; charset=UTF-8', 'Cache-Control: no-store'],
    //         'body' => '<!doctype html><title>Page introuvable</title><h1>404</h1>',
    //     ],
    'not_found_page' => null,

    // ------------------------------------------------------------------ extension et icônes

    // [OPTIONNEL] Lien de l'extension sur le Chrome Web Store (publication « non répertoriée »),
    // ex. 'https://chromewebstore.google.com/detail/…'. Le site affiche alors un bouton d'installation.
    // Voir tools/webstore/README.md pour la publier.
    'extension_store_url' => '',

    // [OPTIONNEL] Icônes des sites : si un site ne fournit pas d'icône d'au moins 128 px, le serveur
    // interroge le service d'icônes de Google, puis celui de DuckDuckGo en dernier recours.
    // Seul le nom de domaine leur est transmis (jamais vos identifiants). false = uniquement les
    // icônes publiées par les sites eux-mêmes.
    'icon_fallback' => true,

    // [OPTIONNEL] Page qui porte l'icône d'un domaine (et de ses sous-domaines), quand la page
    // d'accueil n'en fournit pas de correcte. ex. ['example.com' => 'https://example.com/?app=crm']
    'icon_pages' => [],

    // ------------------------------------------------------------------ partages (Send)

    // [OPTIONNEL] Envoi des liens de partage (Send) par e-mail directement depuis le serveur.
    // Laisser 'host' vide : le site ouvre simplement votre messagerie (lien mailto:).
    //   host   : serveur SMTP, ex. 'smtp.example.com'
    //   port   : 587 avec 'tls', 465 avec 'ssl'
    //   secure : 'tls' (STARTTLS), 'ssl' (TLS direct) ou '' (aucun chiffrement, déconseillé)
    //   user / pass : identifiants SMTP ('' si le serveur n'en demande pas)
    //   from   : expéditeur affiché, ex. 'BioPass <noreply@example.com>'
    'smtp' => [
        'host' => '',
        'port' => 587,
        'secure' => 'tls',
        'user' => '',
        'pass' => '',
        'from' => 'BioPass <noreply@example.com>',
    ],

    // ------------------------------------------------------------------ stockage et sessions

    // [OPTIONNEL] Dossier des données (comptes, coffres chiffrés, sauvegardes, partages). Créé
    // automatiquement : PHP doit pouvoir écrire dans le dossier de BioPass. Ses fichiers sont des .php
    // protégés (ils répondent 404 s'ils sont appelés directement). C'est ce dossier qu'il faut sauvegarder.
    'data_dir' => __DIR__ . '/data',

    // [OPTIONNEL] Nombre d'instantanés quotidiens conservés pour chaque coffre (restaurables depuis le site).
    'backup_days' => 30,

    // [OPTIONNEL] Durée de validité d'une session côté serveur, en secondes (7 jours). Les applications
    // se reconnectent d'elles-mêmes à l'expiration : ce n'est pas le délai de verrouillage du coffre.
    'token_ttl' => 7 * 86400,

    // [OPTIONNEL] true si BioPass est derrière un reverse proxy (adresse IP du client lue dans
    // X-Forwarded-For, HTTPS détecté par X-Forwarded-Proto). Laisser false sinon : ces en-têtes
    // pourraient être falsifiés.
    'trust_proxy' => false,

    // ------------------------------------------------------------------ sécurité (avancé)

    // [AVANCÉ] Itérations PBKDF2-SHA256 minimales acceptées à la création d'un compte.
    'min_iterations' => 600000,

    // [AVANCÉ] Anti force brute : après N échecs de connexion depuis une même adresse IP,
    // les tentatives sont refusées pendant la fenêtre (en secondes).
    'login_max_failures' => 10,
    'login_window' => 900,

    // [AVANCÉ] Taille maximale d'une requête (octets) : import d'un gros coffre, icônes…
    'max_body' => 32 * 1024 * 1024,

    // [AVANCÉ] Emplacement nginx « internal » vers lequel rediriger (X-Accel-Redirect) pour que nginx
    // produise lui-même son 404. Nécessite une modification de la configuration nginx : inutile dans
    // le cas normal, BioPass imitant déjà ce 404 à l'octet près.
    'nginx_404' => '',
];
