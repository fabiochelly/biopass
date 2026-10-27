<?php
// BioPass — actions de l'API (voir PROTOCOL.md).
declare(strict_types=1);
defined('BIOPASS') or require __DIR__ . '/404.php';

require_once __DIR__ . '/lib.php';

function run_api(): void
{
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');

    try {
        $action = $_GET['a'] ?? '';
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        $routes = [
            'prelogin' => ['POST', 'api_prelogin'],
            'register' => ['POST', 'api_register'],
            'login' => ['POST', 'api_login'],
            'sync' => ['GET', 'api_sync'],
            'save' => ['POST', 'api_save'],
            'password' => ['POST', 'api_password'],
            'revoke' => ['POST', 'api_revoke'],
            'favicon' => ['GET', 'api_favicon'],
            'backups' => ['GET', 'api_backups'],
            'send_create' => ['POST', 'api_send_create'],
            'send_list' => ['GET', 'api_send_list'],
            'send_delete' => ['POST', 'api_send_delete'],
            'send_mail' => ['POST', 'api_send_mail'],
            'send_open' => ['POST', 'api_send_open'],
            'send_info' => ['GET', 'api_send_info'],
            'backup' => ['GET', 'api_backup'],
        ];
        if (!isset($routes[$action])) {
            throw new ApiError(404, 'Action inconnue');
        }
        [$expected, $fn] = $routes[$action];
        if ($method !== $expected) {
            throw new ApiError(405, 'Méthode non autorisée');
        }
        $out = $fn($method === 'POST' ? read_body() : []);
        if ($out !== null) { // null : la réponse (binaire) a déjà été envoyée
            echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
    } catch (ApiError $e) {
        http_response_code($e->status);
        echo json_encode(['error' => $e->getMessage()] + $e->extra, JSON_UNESCAPED_UNICODE);
    } catch (\Throwable $e) {
        error_log('BioPass: ' . $e);
        http_response_code(500);
        echo json_encode(['error' => 'Erreur interne du serveur']);
    }
}

function read_body(): array
{
    $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($len > config()['max_body']) {
        throw new ApiError(413, 'Requête trop volumineuse');
    }
    $data = json_decode((string) file_get_contents('php://input', length: config()['max_body'] + 1), true);
    if (!is_array($data)) {
        throw new ApiError(400, 'JSON invalide');
    }
    return $data;
}

function session_out(array $user): array
{
    return [
        'user' => $user['user'],
        'token' => issue_token($user),
        'salt' => $user['salt'],
        'iter' => $user['iter'],
        'wrapped' => $user['wrapped'],
    ];
}

function api_prelogin(array $in): array
{
    $u = norm_user($in['user'] ?? null);
    $user = load_user($u);
    return $user
        ? ['salt' => $user['salt'], 'iter' => $user['iter']]
        : ['salt' => fake_salt($u), 'iter' => config()['min_iterations']];
}

function api_register(array $in): array
{
    $code = (string) config()['registration_code'];
    if ($code === '') {
        throw new ApiError(403, 'Les inscriptions sont fermées');
    }
    rl_check();
    if (!is_string($in['code'] ?? null) || !hash_equals($code, $in['code'])) {
        rl_fail();
        throw new ApiError(403, 'Code d\'inscription incorrect');
    }
    $u = norm_user($in['user'] ?? null);
    $user = [
        'user' => $u,
        'salt' => b64_field($in, 'salt', 16, 64),
        'iter' => iter_field($in),
        'auth' => hash_auth(b64_field($in, 'auth', 32, 32)),
        'wrapped' => b64_field($in, 'wrapped', 60, 60),
        'gen' => 1,
        'created' => time(),
    ];
    with_lock("user-$u", function () use ($u, $user) {
        if (load_user($u)) {
            throw new ApiError(409, 'Cet identifiant existe déjà');
        }
        save_user($user);
    });
    return session_out($user);
}

function api_login(array $in): array
{
    rl_check();
    $u = norm_user($in['user'] ?? null);
    $auth = b64_field($in, 'auth', 32, 32);
    $user = load_user($u);
    // Compte inexistant : on hache quand même pour un temps de réponse comparable.
    $ok = $user ? password_verify($auth, $user['auth']) : (hash_auth($auth) && false);
    if (!$ok) {
        rl_fail();
        throw new ApiError(401, 'Identifiant ou mot de passe incorrect');
    }
    rl_clear();
    if (password_needs_rehash($user['auth'], defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT)) {
        with_lock("user-$u", function () use ($u, $auth) {
            $cur = load_user($u);
            $cur['auth'] = hash_auth($auth);
            save_user($cur);
        });
    }
    return session_out($user);
}

function api_sync(array $in): array
{
    $user = require_user();
    $vault = load_vault($user['user']);
    $since = (int) ($_GET['since'] ?? 0);
    $full = $since <= 0 || $since > $vault['rev'];
    $items = [];
    foreach ($vault['items'] as $id => $it) {
        if ($full ? !$it['del'] : $it['rev'] > $since) {
            $items[] = ['id' => (string) $id, 'rev' => $it['rev'], 'enc' => $it['enc'], 'del' => $it['del']];
        }
    }
    return ['rev' => $vault['rev'], 'full' => $full, 'items' => $items];
}

function api_save(array $in): array
{
    $user = require_user();
    $changes = $in['changes'] ?? null;
    if (!is_array($changes) || !array_is_list($changes) || count($changes) === 0 || count($changes) > 20000) {
        throw new ApiError(400, 'Liste de modifications invalide');
    }
    $seen = [];
    foreach ($changes as $i => $c) {
        $id = $c['id'] ?? null;
        if (!is_string($id) || !preg_match('/^[a-f0-9]{32}$/', $id) || isset($seen[$id])) {
            throw new ApiError(400, "Identifiant d'entrée invalide (#$i)");
        }
        $seen[$id] = true;
        if (!is_int($c['prev'] ?? null) || $c['prev'] < 0) {
            throw new ApiError(400, "Révision invalide (#$i)");
        }
        if (($c['del'] ?? false) !== true) {
            b64_field($c, 'enc', 28, 4 * 1024 * 1024);
        }
    }

    $u = $user['user'];
    return with_lock("vault-$u", function () use ($u, $changes) {
        $vault = load_vault($u);
        $conflicts = [];
        foreach ($changes as $c) {
            // une entrée supprimée vaut « inexistante » : prev = 0 la recrée (restauration d'une sauvegarde),
            // toute autre révision reste un conflit
            $cur = $vault['items'][$c['id']] ?? null;
            if (($cur && !$cur['del'] ? $cur['rev'] : 0) !== $c['prev']) {
                $conflicts[] = $c['id'];
            }
        }
        if ($conflicts) {
            throw new ApiError(409, 'Des entrées ont été modifiées entre-temps', ['conflicts' => $conflicts]);
        }
        backup($u);
        $rev = $vault['rev'] + 1;
        foreach ($changes as $c) {
            $del = ($c['del'] ?? false) === true;
            $vault['items'][$c['id']] = ['rev' => $rev, 'enc' => $del ? null : $c['enc'], 'del' => $del];
        }
        $vault['rev'] = $rev;
        write_json(vault_file($u), $vault);
        return ['rev' => $rev];
    });
}

function api_password(array $in): array
{
    $user = require_user();
    rl_check();
    if (!password_verify(b64_field($in, 'auth', 32, 32), $user['auth'])) {
        rl_fail();
        throw new ApiError(403, 'Mot de passe actuel incorrect');
    }
    $salt = b64_field($in, 'salt', 16, 64);
    $iter = iter_field($in);
    $auth = hash_auth(b64_field($in, 'auth_new', 32, 32));
    $wrapped = b64_field($in, 'wrapped', 60, 60);
    $u = $user['user'];
    $updated = with_lock("user-$u", function () use ($u, $salt, $iter, $auth, $wrapped) {
        backup($u);
        $cur = load_user($u);
        $cur = ['salt' => $salt, 'iter' => $iter, 'auth' => $auth, 'wrapped' => $wrapped, 'gen' => $cur['gen'] + 1] + $cur;
        save_user($cur);
        return $cur;
    });
    return ['token' => issue_token($updated)];
}

// ---------------------------------------------------------------- Send (partages chiffrés)

// {id, enc, access, label, expires_in, max_views, pin} → {id, expires}
function api_send_create(array $in): array
{
    $u = require_user()['user'];
    require_once __DIR__ . '/send.php';
    if (!send_id_ok($in['id'] ?? null) || is_file(send_file($in['id']))) {
        throw new ApiError(400, 'Identifiant de partage invalide');
    }
    $ttl = (int) ($in['expires_in'] ?? 0);
    $views = (int) ($in['max_views'] ?? 0);
    if ($ttl < 60 || $ttl > SEND_MAX_TTL || $views < 0 || $views > SEND_MAX_VIEWS) {
        throw new ApiError(400, 'Expiration ou nombre de consultations invalide');
    }
    send_purge();
    $send = [
        'owner' => $u,
        'enc' => b64_field($in, 'enc', 28, 2 * 1024 * 1024),
        'access' => hash_auth(b64_field($in, 'access', 32, 32)),
        'label' => b64_field($in, 'label', 28, 4096), // titre chiffré avec la clé du coffre (liste de l'expéditeur)
        'pin' => ($in['pin'] ?? false) === true,
        'created' => time(),
        'expires' => time() + $ttl,
        'max_views' => $views,
        'views' => 0,
        'attempts' => 0,
        'opened' => [],
    ];
    write_json(send_file($in['id']), $send);
    return ['id' => $in['id'], 'expires' => $send['expires']];
}

function api_send_list(array $in): array
{
    $u = require_user()['user'];
    require_once __DIR__ . '/send.php';
    send_purge();
    $out = [];
    foreach (glob(data_path('sends/*.php')) ?: [] as $f) {
        $id = basename($f, '.php');
        $s = send_id_ok($id) ? read_json($f) : null;
        if ($s && $s['owner'] === $u) {
            $out[] = ['id' => $id, 'label' => $s['label'], 'created' => $s['created'], 'expires' => $s['expires'], 'max_views' => $s['max_views'],
                'views' => $s['views'], 'pin' => $s['pin'], 'alive' => send_alive($s), 'opened' => $s['opened']];
        }
    }
    usort($out, fn($a, $b) => $b['created'] <=> $a['created']);
    return ['sends' => $out, 'smtp' => smtp_configured()];
}

function api_send_delete(array $in): array
{
    $u = require_user()['user'];
    require_once __DIR__ . '/send.php';
    $s = load_send((string) ($in['id'] ?? ''));
    if (!$s || $s['owner'] !== $u) {
        throw new ApiError(404, 'Partage introuvable');
    }
    @unlink(send_file($in['id']));
    return ['ok' => true];
}

// Envoi du lien par e-mail via le SMTP configuré. Le texte est composé par le client (il contient le lien).
function api_send_mail(array $in): array
{
    $u = require_user()['user'];
    require_once __DIR__ . '/send.php';
    if (!smtp_configured()) {
        throw new ApiError(501, 'Aucun serveur SMTP configuré');
    }
    $to = trim((string) ($in['to'] ?? ''));
    if (!filter_var($to, FILTER_VALIDATE_EMAIL) || !is_string($in['subject'] ?? null) || !is_string($in['text'] ?? null) || !is_string($in['html'] ?? null)) {
        throw new ApiError(400, 'Adresse e-mail invalide');
    }
    // au plus 30 e-mails par heure et par utilisateur
    $rl = data_path("ratelimit/mail-$u.php");
    $d = read_json($rl);
    if (!$d || time() - $d['t'] > 3600) {
        $d = ['n' => 0, 't' => time()];
    }
    if (++$d['n'] > 30) {
        throw new ApiError(429, 'Trop d\'e-mails envoyés, réessayez plus tard');
    }
    write_json($rl, $d);
    smtp_send($to, mb_substr($in['subject'], 0, 200), mb_substr($in['text'], 0, 20000), mb_substr($in['html'], 0, 60000));
    return ['ok' => true];
}

// Public : état d'un partage, sans rien consommer → {pin, alive, expires, views_left}
function api_send_info(array $in): array
{
    require_once __DIR__ . '/send.php';
    $s = load_send((string) ($_GET['s'] ?? ''));
    if (!$s) {
        throw new ApiError(404, 'Ce partage n\'existe pas');
    }
    return ['pin' => $s['pin'], 'alive' => send_alive($s), 'expires' => $s['expires'],
        'views_left' => $s['max_views'] ? max(0, $s['max_views'] - $s['views']) : null];
}

// Public (sans clé d'accès ni session) : {id, access} → {enc, expires, views_left, pin}.
// Code faux : 403 ; au bout de SEND_MAX_ATTEMPTS échecs, le partage est détruit.
function api_send_open(array $in): array
{
    require_once __DIR__ . '/send.php';
    $id = (string) ($_GET['s'] ?? $in['id'] ?? '');
    return with_lock("send-$id", function () use ($id, $in) {
        $s = load_send($id);
        if (!$s) {
            throw new ApiError(404, 'Ce partage n\'existe pas');
        }
        if (!send_alive($s)) {
            throw new ApiError(410, 'Ce partage n\'est plus disponible (expiré, déjà consulté ou révoqué)');
        }
        $access = $in['access'] ?? null;
        if (!is_string($access) || !password_verify($access, $s['access'])) {
            $s['attempts']++;
            if ($s['attempts'] >= SEND_MAX_ATTEMPTS) {
                $s['enc'] = null; // détruit
            }
            write_json(send_file($id), $s);
            throw new ApiError(403, $s['enc'] === null ? 'Trop de codes incorrects : le partage a été détruit' : 'Code incorrect');
        }
        $enc = $s['enc'];
        $s['views']++;
        $s['opened'][] = time();
        $s['opened'] = array_slice($s['opened'], -20);
        if (!send_alive($s)) {
            $s['enc'] = null; // dernière consultation : le contenu est effacé du serveur
        }
        write_json(send_file($id), $s);
        return ['enc' => $enc, 'expires' => $s['expires'], 'views_left' => $s['max_views'] ? $s['max_views'] - $s['views'] : null];
    });
}

// Sauvegardes quotidiennes de l'utilisateur connecté : [{date, rev, count}] (plus récente d'abord).
function api_backups(array $in): array
{
    $u = require_user()['user'];
    $out = [];
    foreach (glob(data_path("backups/$u/*.php")) ?: [] as $f) {
        $date = basename($f, '.php');
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            continue;
        }
        $b = read_json($f);
        $items = $b['vault']['items'] ?? [];
        $out[] = ['date' => $date, 'rev' => $b['vault']['rev'] ?? 0, 'count' => count(array_filter($items, fn($i) => !$i['del']))];
    }
    usort($out, fn($a, $b) => strcmp($b['date'], $a['date']));
    return ['backups' => $out];
}

// Contenu (chiffré) d'une sauvegarde : &date=AAAA-MM-JJ → {date, rev, items:[{id, rev, enc}]}.
// Chiffré avec la même clé de coffre que le coffre actuel : seul le client peut le lire.
function api_backup(array $in): array
{
    $u = require_user()['user'];
    $date = (string) ($_GET['date'] ?? '');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) || !($b = read_json(data_path("backups/$u/$date.php")))) {
        throw new ApiError(404, 'Sauvegarde introuvable');
    }
    $items = [];
    foreach ($b['vault']['items'] ?? [] as $id => $it) {
        if (!$it['del']) {
            $items[] = ['id' => (string) $id, 'rev' => $it['rev'], 'enc' => $it['enc']];
        }
    }
    return ['date' => $date, 'rev' => $b['vault']['rev'] ?? 0, 'items' => $items];
}

// Icône d'un site (relais, rien n'est conservé) : ?url=https://site
function api_favicon(array $in): ?array
{
    require_user();
    if (!function_exists('curl_init')) {
        throw new ApiError(501, 'Extension PHP curl requise pour les icônes');
    }
    require_once __DIR__ . '/favicon.php';
    $icon = fetch_favicon((string) ($_GET['url'] ?? ''));
    if (!$icon) {
        throw new ApiError(404, 'Icône introuvable');
    }
    header('Content-Type: ' . $icon['type']);
    header("Content-Security-Policy: sandbox; default-src 'none'"); // un SVG ne peut rien exécuter
    header('Cache-Control: private, max-age=86400');
    header('Content-Length: ' . strlen($icon['body']));
    echo $icon['body'];
    return null;
}

function api_revoke(array $in): array
{
    $u = require_user()['user'];
    $updated = with_lock("user-$u", function () use ($u) {
        $cur = load_user($u);
        $cur['gen']++;
        save_user($cur);
        return $cur;
    });
    return ['token' => issue_token($updated)];
}
