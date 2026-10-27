<?php
// BioPass — application web : contrôle de la clé d'accès, puis service des fichiers de l'app
// (index.php?f=assets/app.js…). Aucune configuration du serveur web n'est nécessaire : seuls des
// fichiers .php sont déployés, et tout ce qui n'est pas un point d'entrée répond 404.
declare(strict_types=1);

const BIOPASS = 1;
require __DIR__ . '/src/lib.php';

header_remove('X-Powered-By');

// Page d'un partage (Send) : accessible sans clé d'accès, uniquement pour un partage existant et
// uniquement ce dont la page a besoin. Tout le reste passe par le contrôle de la clé.
$sendId = $_GET['s'] ?? null;
$isSend = is_string($sendId) && preg_match('/^[A-Za-z0-9_-]{22}$/', $sendId) && is_file(data_path("sends/$sendId.php"));
if ($isSend) {
    $source = '';
    $path = is_string($_GET['f'] ?? null) ? $_GET['f'] : 'send.html';
    if (!in_array($path, ['send.html', 'assets/send.js', 'assets/core.js', 'assets/icons.js', 'assets/style.css', 'icon.svg'], true)) {
        not_found();
    }
} else {
    $source = require_access_key();
    $path = is_string($_GET['f'] ?? null) ? $_GET['f'] : 'index.html';
}
$body = web_file($path);
if ($body === null) {
    not_found();
}
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
if ($source === 'get' || ($source !== '' && $path === 'index.html')) {
    set_access_cookie($base . '/'); // le navigateur charge ensuite les ressources sans ?k
}

header('Content-Type: ' . web_type($path));
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-cache');
if (in_array($path, ['downloads/biopass.apk', 'downloads/biopass-extension.zip', 'downloads/biopass.crx'], true)) {
    header('Content-Disposition: attachment; filename="' . basename($path) . '"');
}
if ($path === 'send.html') {
    $body = str_replace('__S__', htmlspecialchars((string) $sendId), $body);
}
if ($path === 'index.html' || $path === 'send.html') {
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
}

$key = (string) config()['access_key'];
if ($key !== '' && $path === 'index.html') {
    // la page affiche l'adresse complète (avec la clé) à saisir dans l'extension et les apps
    $body = str_replace('<meta name="bp-key" content="">', '<meta name="bp-key" content="' . htmlspecialchars($key) . '">', $body);
} elseif ($key !== '' && $path === 'manifest.webmanifest') {
    // l'app installée (écran d'accueil) et ses icônes sont chargées sans cookie par certains navigateurs
    $body = preg_replace_callback('#"(start_url|src)": "([^"]*)"#', fn($m) => sprintf('"%s": "%s%sk=%s"', $m[1], $m[2], str_contains($m[2], '?') ? '&' : '?', rawurlencode($key)), $body);
}

$etag = '"' . hash('xxh128', $body) . '"';
header("ETag: $etag");
if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
    http_response_code(304);
    exit;
}
header('Content-Length: ' . strlen($body));
echo $body;
