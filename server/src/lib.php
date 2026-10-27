<?php
// BioPass — fonctions communes du serveur (stockage fichiers, tokens, limitation).
declare(strict_types=1);
defined('BIOPASS') or require __DIR__ . '/404.php';

final class ApiError extends \Exception
{
    public function __construct(public readonly int $status, string $message, public readonly array $extra = [])
    {
        parent::__construct($message);
    }
}

// OPcache est souvent réglé en production pour ne jamais relire un script déjà compilé
// (opcache.validate_timestamps=0) : un fichier remplacé resterait servi dans son ancienne version.
// On demande donc la relecture de nos propres fichiers s'ils ont changé sur le disque (simple stat).
function refresh_opcache(): void
{
    static $done = false;
    if ($done || !function_exists('opcache_invalidate')) {
        return;
    }
    $done = true;
    $root = dirname(__DIR__);
    foreach (['index.php', 'api.php', 'config.php', 'web.php', 'downloads.php', 'src/lib.php', 'src/api.php', 'src/404.php', 'src/index.php', 'src/favicon.php', 'src/send.php', 'bin/index.php'] as $f) {
        @opcache_invalidate("$root/$f"); // sans « force » : seulement si le fichier est plus récent
    }
}

function config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        refresh_opcache();
        $defaults = [
            'data_dir' => dirname(__DIR__) . '/data',
            'registration_code' => '',
            'token_ttl' => 7 * 86400,
            'min_iterations' => 600000,
            'max_body' => 32 * 1024 * 1024,
            'login_max_failures' => 10,
            'login_window' => 900,
            'backup_days' => 30,
            'trust_proxy' => false,
            'access_key' => '',
            'nginx_404' => '',
            'not_found_page' => null,
        ];
        $file = dirname(__DIR__) . '/config.php';
        $cfg = is_file($file) ? array_merge($defaults, require $file) : $defaults;
    }
    return $cfg;
}

// ---------------------------------------------------------------- clé d'accès

// Sans clé valide : la réponse qu'on obtiendrait si BioPass n'existait pas.
// - URL en .php (api.php, index.php) : 404 de nginx pour un script inexistant ;
// - URL de dossier (/biopass/) : page configurée dans 'not_found_page' (celle de l'application
//   qui reçoit les URL inconnues), sinon le 404 nginx.
function not_found(): never
{
    $loc = (string) config()['nginx_404'];
    if ($loc !== '') {
        header_remove('X-Powered-By');
        header("X-Accel-Redirect: $loc"); // nginx produit lui-même son 404 (configuration dédiée)
        exit;
    }
    $page = config()['not_found_page'];
    $path = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (is_array($page) && !str_ends_with($path, '.php')) {
        header_remove('X-Powered-By');
        http_response_code(404);
        foreach ($page['headers'] ?? [] as $h) {
            header($h);
        }
        echo $page['body'] ?? '';
        exit;
    }
    require __DIR__ . '/404.php';
}

function is_https(): bool
{
    if (config()['trust_proxy'] && ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') {
        return true;
    }
    return ($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off';
}

// Chaque dossier existant de data/ reçoit son index.php (sinon nginx répond 403 au lieu de 404).
function protect_data_dirs(): void
{
    if (!is_dir(data_path())) {
        return;
    }
    foreach (['', '/users', '/vaults', '/locks', '/backups', '/ratelimit', '/sends'] as $d) {
        if (is_dir(data_path() . $d) && !is_file(data_path() . "$d/index.php")) {
            ensure_dir(data_path() . $d);
        }
    }
}

// Clé acceptée dans ?k=, l'en-tête X-BP-Key (apps, extension) ou le cookie bpk (navigateur).
// Retourne la source de la clé valide, '' si aucune clé n'est configurée ; 404 sinon.
function require_access_key(): string
{
    protect_data_dirs();
    $key = (string) config()['access_key'];
    if ($key === '') {
        return '';
    }
    foreach (['get' => $_GET['k'] ?? null, 'header' => $_SERVER['HTTP_X_BP_KEY'] ?? null, 'cookie' => $_COOKIE['bpk'] ?? null] as $src => $v) {
        if (is_string($v) && hash_equals($key, $v)) {
            return $src;
        }
    }
    not_found();
}

function set_access_cookie(string $path): void
{
    setcookie('bpk', (string) config()['access_key'], [
        'expires' => time() + 400 * 86400,
        'path' => $path,
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

// ---------------------------------------------------------------- fichiers de l'app web

// Fichiers servis par index.php?f=… : chemin → type MIME (liste blanche).
function web_type(string $path): ?string
{
    $fixed = [
        'index.html' => 'text/html; charset=utf-8',
        'sw.js' => 'text/javascript; charset=utf-8',
        'manifest.webmanifest' => 'application/manifest+json',
        'icon.svg' => 'image/svg+xml',
        'send.html' => 'text/html; charset=utf-8',
        'icon-192.png' => 'image/png',
        'icon-512.png' => 'image/png',
        'downloads/biopass.apk' => 'application/vnd.android.package-archive',
        'downloads/biopass-extension.zip' => 'application/zip',
        'downloads/versions.json' => 'application/json',
        'downloads/biopass.crx' => 'application/x-chrome-extension',
        'downloads/update.xml' => 'application/xml',
        'downloads/install-brave.sh' => 'text/plain; charset=utf-8',
    ];
    if (isset($fixed[$path])) {
        return $fixed[$path];
    }
    if (preg_match('#^assets/[a-z0-9-]+\.(js|css)$#', $path, $m)) {
        return $m[1] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
    }
    return null;
}

// Contenu d'un fichier de l'app : depuis web.php / downloads.php (générés par bin/build-web.php,
// seuls déployés), sinon depuis le dossier web/ (développement).
function web_file(string $path): ?string
{
    if (web_type($path) === null) {
        return null;
    }
    $root = dirname(__DIR__);
    $bundle = str_starts_with($path, 'downloads/') ? "$root/downloads.php" : "$root/web.php";
    if (is_file($bundle)) {
        $files = require $bundle;
        return isset($files[$path]) ? base64_decode($files[$path]) : null;
    }
    $file = "$root/web/$path";
    return is_file($file) ? (string) file_get_contents($file) : null;
}

// ---------------------------------------------------------------- fichiers

function data_path(string $sub = ''): string
{
    $dir = rtrim(config()['data_dir'], '/');
    return $sub === '' ? $dir : "$dir/$sub";
}

function ensure_dir(string $dir): void
{
    // les dossiers parents dans data/ d'abord (chacun reçoit aussi son index.php)
    $parent = dirname($dir);
    if ($dir !== data_path() && str_starts_with($parent, data_path())) {
        ensure_dir($parent);
    }
    if (!is_dir($dir) && !@mkdir($dir, 0700) && !is_dir($dir)) {
        throw new ApiError(500, 'Stockage inaccessible : le dossier data/ doit être inscriptible par PHP');
    }
    // un dossier appelé directement doit répondre comme s'il n'existait pas (sinon nginx : 403)
    if (!is_file("$dir/index.php")) {
        @file_put_contents("$dir/index.php", "<?php\nrequire " . var_export(__DIR__ . '/index.php', true) . ";\n");
    }
}

// Les données sont des fichiers .php commençant par une garde : servis directement par le
// serveur web, ils s'exécutent et répondent 404 au lieu de livrer leur contenu.
// Garde autonome (indépendante de l'emplacement du fichier) : 404 nginx puis arrêt.
function guard_line(): string
{
    return '<?php header_remove("X-Powered-By");http_response_code(404);ini_set("default_charset","");'
        . 'header("Content-Type: text/html");header("Content-Length: 146");'
        . 'exit("<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n");?>' . "\n";
}

function read_json(string $file): ?array
{
    $raw = @file_get_contents($file);
    if ($raw === false) {
        return null;
    }
    if (str_starts_with($raw, '<?php')) {
        $raw = substr($raw, strpos($raw, "?>\n") + 3);
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new ApiError(500, 'Fichier de données corrompu');
    }
    return $data;
}

// Écriture atomique : fichier temporaire + fsync + rename.
function write_json(string $file, array $data): void
{
    ensure_dir(dirname($file));
    // JSON_HEX_TAG : aucun « <? » ne peut apparaître après la garde
    $json = guard_line() . json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_THROW_ON_ERROR);
    $tmp = $file . '.' . bin2hex(random_bytes(6)) . '.tmp.php';
    $h = @fopen($tmp, 'x');
    $ok = $h && fwrite($h, $json) === strlen($json) && fflush($h) && fsync($h);
    if ($h) {
        fclose($h);
    }
    if (!$ok || !rename($tmp, $file)) {
        @unlink($tmp);
        throw new ApiError(500, 'Écriture impossible (le dossier data/ doit être inscriptible par PHP)');
    }
}

function with_lock(string $name, callable $fn): mixed
{
    ensure_dir(data_path('locks'));
    $file = data_path("locks/$name.php");
    $h = fopen($file, 'c+');
    if (!$h || !flock($h, LOCK_EX)) {
        throw new ApiError(500, 'Verrou impossible');
    }
    if (fstat($h)['size'] === 0) {
        fwrite($h, guard_line()); // même un verrou ne doit pas répondre autre chose que 404
    }
    try {
        return $fn();
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
}

function server_secret(): string
{
    static $secret = null;
    if ($secret !== null) {
        return $secret;
    }
    $file = data_path('secret.php');
    $hex = read_json($file)['key'] ?? null;
    if (!is_string($hex)) {
        $hex = with_lock('secret', function () use ($file) {
            $cur = read_json($file)['key'] ?? null;
            if (is_string($cur)) {
                return $cur;
            }
            $new = bin2hex(random_bytes(32));
            write_json($file, ['key' => $new]);
            return $new;
        });
    }
    return $secret = hex2bin($hex);
}

// ---------------------------------------------------------------- validation

function norm_user(mixed $u): string
{
    if (!is_string($u)) {
        throw new ApiError(400, 'Identifiant manquant');
    }
    $u = strtolower(trim($u));
    if (!preg_match('/^[a-z0-9][a-z0-9._-]{0,31}$/', $u)) {
        throw new ApiError(400, 'Identifiant invalide (lettres, chiffres, . _ -)');
    }
    return $u;
}

function b64_field(array $in, string $key, int $min, int $max): string
{
    $v = $in[$key] ?? null;
    $bin = is_string($v) ? base64_decode($v, true) : false;
    if ($bin === false || strlen($bin) < $min || strlen($bin) > $max) {
        throw new ApiError(400, "Champ « $key » invalide");
    }
    return $v;
}

function iter_field(array $in): int
{
    $it = $in['iter'] ?? null;
    if (!is_int($it) || $it < config()['min_iterations'] || $it > 10_000_000) {
        throw new ApiError(400, 'Nombre d\'itérations invalide (minimum ' . config()['min_iterations'] . ')');
    }
    return $it;
}

function hash_auth(string $auth): string
{
    return password_hash($auth, defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT);
}

// ---------------------------------------------------------------- utilisateurs

function user_file(string $u): string
{
    return data_path("users/$u.php");
}

function load_user(string $u): ?array
{
    return read_json(user_file($u));
}

function save_user(array $user): void
{
    write_json(user_file($user['user']), $user);
}

// Salt factice déterministe : prelogin ne révèle pas si un compte existe.
function fake_salt(string $u): string
{
    return base64_encode(substr(hash_hmac('sha256', "salt:$u", server_secret(), true), 0, 16));
}

// ---------------------------------------------------------------- coffres

function vault_file(string $u): string
{
    return data_path("vaults/$u.php");
}

function load_vault(string $u): array
{
    return read_json(vault_file($u)) ?? ['rev' => 0, 'items' => []];
}

// Instantané quotidien (état avant la première modification du jour).
function backup(string $u): void
{
    $dir = data_path("backups/$u");
    $dst = "$dir/" . date('Y-m-d') . '.php';
    if (is_file($dst)) {
        return;
    }
    write_json($dst, ['user' => load_user($u), 'vault' => load_vault($u)]);
    $files = glob("$dir/*.php") ?: [];
    sort($files);
    foreach (array_slice($files, 0, max(0, count($files) - config()['backup_days'])) as $old) {
        @unlink($old);
    }
}

// ---------------------------------------------------------------- tokens

function b64url(string $s): string
{
    return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

function b64url_decode(string $s): string|false
{
    $s = strtr($s, '-_', '+/');
    return base64_decode(str_pad($s, strlen($s) + (4 - strlen($s) % 4) % 4, '='), true);
}

function issue_token(array $user): string
{
    $payload = b64url(json_encode(['u' => $user['user'], 'g' => $user['gen'], 'e' => time() + config()['token_ttl']]));
    return $payload . '.' . b64url(hash_hmac('sha256', $payload, server_secret(), true));
}

function require_user(): array
{
    $token = $_SERVER['HTTP_X_BP_TOKEN'] ?? '';
    [$payload, $sig] = array_pad(explode('.', $token, 2), 2, '');
    if ($payload === '' || !hash_equals(b64url(hash_hmac('sha256', $payload, server_secret(), true)), $sig)) {
        throw new ApiError(401, 'Session invalide');
    }
    $d = json_decode((string) b64url_decode($payload), true);
    if (!is_array($d) || ($d['e'] ?? 0) < time()) {
        throw new ApiError(401, 'Session expirée');
    }
    $user = load_user(norm_user($d['u'] ?? ''));
    if (!$user || $user['gen'] !== ($d['g'] ?? null)) {
        throw new ApiError(401, 'Session révoquée');
    }
    return $user;
}

// ---------------------------------------------------------------- limitation des échecs

function client_ip(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0';
    if (config()['trust_proxy'] && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        $ip = trim(end($parts)); // entrée ajoutée par le proxy de confiance
    }
    return $ip;
}

function rl_file(): string
{
    return data_path('ratelimit/' . hash('sha256', client_ip()) . '.php');
}

function rl_check(): void
{
    $d = read_json(rl_file());
    if ($d && $d['n'] >= config()['login_max_failures'] && time() - $d['t'] < config()['login_window']) {
        throw new ApiError(429, 'Trop de tentatives, réessayez dans quelques minutes');
    }
}

function rl_fail(): void
{
    $file = rl_file();
    $d = read_json($file);
    if (!$d || time() - $d['t'] >= config()['login_window']) {
        $d = ['n' => 0, 't' => time()];
    }
    $d['n']++;
    write_json($file, $d);
}

function rl_clear(): void
{
    @unlink(rl_file());
}
