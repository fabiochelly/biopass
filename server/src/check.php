<?php
// BioPass — vérification des adresses enregistrées (nettoyage du coffre). Le client envoie une adresse,
// le serveur dit si le site existe encore : réponse HTTP, puis, pour un nom qui ne répond pas, existence
// du domaine (DNS) et enregistrement auprès du registre (RDAP). Rien n'est conservé, sauf l'annuaire
// public des serveurs RDAP de l'IANA, mis en cache.
declare(strict_types=1);
defined('BIOPASS') or require __DIR__ . '/404.php';

require_once __DIR__ . '/favicon.php';

const CHECK_TIMEOUT = 8;
const CHECK_HOPS = 6;
const CHECK_BUDGET = 25; // secondes au plus par adresse (https, repli http, page d'accueil, RDAP)
const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const RDAP_TTL = 7 * 86400;
// suffixes à deux niveaux : même liste que baseDomain() dans core.js
const CHECK_MULTI = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp',
    'com.br', 'com.mx', 'co.za', 'com.tr', 'co.in', 'com.cn', 'com.hk', 'com.sg', 'co.kr', 'com.ar', 'gouv.fr', 'asso.fr', 'co.il'];

function base_domain(string $host): string
{
    $p = explode('.', rtrim($host, '.'));
    if (count($p) <= 2 || filter_var($host, FILTER_VALIDATE_IP)) {
        return $host;
    }
    return implode('.', array_slice($p, in_array(implode('.', array_slice($p, -2)), CHECK_MULTI, true) ? -3 : -2));
}

// GET d'une adresse, redirections suivies à la main (chaque saut repasse par outbound_target).
// $max = 0 : les en-têtes suffisent, la connexion est coupée au premier octet du corps.
// → ['code', 'url' (dernière adresse), 'hop', 'body'?] ou ['error' => motif, 'url', 'hop']
function check_fetch(string $url, float $deadline, int $max = 0): array
{
    for ($hop = 0; $hop <= CHECK_HOPS; $hop++) {
        $t = outbound_target($url);
        $left = (int) ceil($deadline - microtime(true));
        if (!is_array($t) || $left <= 0) {
            return ['error' => is_array($t) ? 'timeout' : $t, 'url' => $url, 'hop' => $hop];
        }
        $body = '';
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RESOLVE => [$t['resolve']],
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT => min(CHECK_TIMEOUT, $left),
            CURLOPT_CONNECTTIMEOUT => min(5, $left),
            CURLOPT_USERAGENT => ICON_UA,
            CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language: fr-FR,fr;q=0.9,en;q=0.8'],
            CURLOPT_ENCODING => '',
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$body, $max) {
                $body .= $chunk;
                return strlen($body) > $max ? 0 : strlen($chunk);
            },
        ]);
        curl_exec($ch);
        $errno = curl_errno($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $location = (string) curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        if ($code === 0) {
            return ['error' => curl_reason($errno), 'url' => $url, 'hop' => $hop];
        }
        if ($code >= 300 && $code < 400 && $location !== '') {
            $url = $location;
            continue;
        }
        return ['code' => $code, 'url' => $url, 'hop' => $hop] + ($max ? ['body' => substr($body, 0, $max)] : []);
    }
    return ['error' => 'loop', 'url' => $url, 'hop' => $hop];
}

function curl_reason(int $errno): string
{
    // codes libcurl en clair : les constantes PHP des erreurs TLS récentes n'existent pas toutes
    return match ($errno) {
        28 => 'timeout',
        7 => 'refused',
        52 => 'empty',
        55, 56 => 'reset',
        35, 51, 53, 54, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91 => 'tls',
        default => 'error',
    };
}

const CHECK_REASONS = [
    'timeout' => 'Le site ne répond pas (délai dépassé)',
    'refused' => 'Connexion refusée : aucun site web à cette adresse',
    'empty' => 'Le serveur a fermé la connexion sans répondre',
    'reset' => 'Connexion interrompue par le serveur',
    'tls' => 'Connexion sécurisée impossible (certificat invalide ou expiré)',
    'loop' => 'Trop de redirections',
    'error' => 'Erreur de connexion',
];

// Le domaine a-t-il des serveurs DNS ? null : résolveur en échec (impossible de conclure).
function domain_has_dns(string $domain): ?bool
{
    $ns = @dns_get_record($domain, DNS_NS);
    if ($ns) {
        return true;
    }
    $soa = @dns_get_record($domain, DNS_SOA);
    return $soa ? true : ($ns === false && $soa === false ? null : false);
}

// Serveur RDAP du registre d'une extension (.fr → https://rdap.nic.fr/), d'après l'annuaire de l'IANA.
function rdap_base(string $tld, float $deadline): ?string
{
    $file = data_path('cache/rdap.php');
    $cache = read_json($file);
    if (!$cache || time() - $cache['t'] > RDAP_TTL) {
        $r = check_fetch(RDAP_BOOTSTRAP, $deadline, 1024 * 1024);
        $json = ($r['code'] ?? 0) === 200 ? json_decode($r['body'], true) : null;
        if (is_array($json['services'] ?? null)) {
            $tlds = [];
            foreach ($json['services'] as $s) {
                $https = array_values(array_filter((array) ($s[1] ?? []), fn($u) => str_starts_with((string) $u, 'https://')));
                foreach ($https ? (array) $s[0] : [] as $t) {
                    $tlds[strtolower((string) $t)] = rtrim($https[0], '/') . '/';
                }
            }
            $cache = ['t' => time(), 'tlds' => $tlds];
            write_json($file, $cache);
        }
    }
    return $cache['tlds'][$tld] ?? null;
}

// Enregistrement du domaine auprès de son registre : ['registered' => bool, 'expires' => ?'AAAA-MM-JJ',
// 'status' => [...]] ; null si l'extension n'a pas de serveur RDAP ou s'il ne répond pas.
function rdap_domain(string $domain, float $deadline): ?array
{
    $base = rdap_base(substr(strrchr(".$domain", '.'), 1), $deadline);
    if (!$base) {
        return null;
    }
    $r = check_fetch($base . 'domain/' . rawurlencode($domain), $deadline, 256 * 1024);
    if (($r['code'] ?? 0) === 404) {
        return ['registered' => false, 'expires' => null, 'status' => []];
    }
    $json = ($r['code'] ?? 0) === 200 ? json_decode($r['body'], true) : null;
    if (!is_array($json)) {
        return null;
    }
    $expires = null;
    foreach ((array) ($json['events'] ?? []) as $e) {
        if (($e['eventAction'] ?? '') === 'expiration' && is_string($e['eventDate'] ?? null)) {
            $expires = substr($e['eventDate'], 0, 10);
        }
    }
    return ['registered' => true, 'expires' => $expires, 'status' => array_values(array_map('strval', (array) ($json['status'] ?? [])))];
}

// Nom qui ne se résout pas : le domaine existe-t-il encore ?
function check_missing_host(string $host, string $domain, float $deadline): array
{
    $dns = domain_has_dns($domain);
    if ($dns === null) {
        return ['status' => 'down', 'detail' => "Résolution DNS impossible pour l'instant"];
    }
    if ($dns) {
        return ['status' => 'nohost', 'detail' => $host === $domain || $host === "www.$domain"
            ? "Le domaine $domain existe mais ne pointe vers aucun site web"
            : "Le nom $host n'existe plus (le domaine $domain existe toujours)"];
    }
    $rdap = rdap_domain($domain, $deadline);
    if ($rdap === null) {
        return ['status' => 'nodomain', 'detail' => "Aucun serveur DNS pour $domain : domaine inexistant ou expiré"];
    }
    if (!$rdap['registered']) {
        return ['status' => 'nodomain', 'rdap' => $rdap, 'detail' => "Le domaine $domain n'est plus enregistré (expiré et supprimé, ou n'a jamais existé)"];
    }
    $labels = ['redemption period' => 'expiré, en période de rédemption', 'pending delete' => 'en attente de suppression',
        'client hold' => 'suspendu', 'server hold' => 'suspendu par le registre', 'inactive' => 'inactif'];
    $why = array_values(array_unique(array_intersect_key($labels, array_flip(array_map('strtolower', $rdap['status'])))));
    $exp = $rdap['expires'] ? ', expiration le ' . date('d/m/Y', strtotime($rdap['expires'])) : '';
    return ['status' => 'nodomain', 'rdap' => $rdap,
        'detail' => "Le domaine $domain est encore enregistré" . ($why ? ' (' . implode(', ', $why) . ')' : '') . "$exp, mais n'a plus de serveur DNS"];
}

// Adresse enregistrée → ['url', 'status', 'detail', 'code'?, 'final'?, 'domain'?, 'rdap'?]
// status : ok, moved (redirige vers un autre domaine), notfound (404/410), error (autre erreur HTTP),
// down (injoignable), nohost (nom introuvable, domaine existant), nodomain (domaine inexistant ou
// expiré), skip (non vérifiable depuis le serveur : port, réseau interne, adresse invalide).
function check_url(string $input): array
{
    $deadline = microtime(true) + CHECK_BUDGET;
    $url = preg_replace('/#.*$/s', '', trim($input));
    $url = preg_match('#^https?://#i', $url) ? $url : (preg_match('#^[a-z][a-z0-9+.-]*:#i', $url) ? '' : "https://$url");
    $p = parse_url($url) ?: [];
    $host = strtolower($p['host'] ?? '');
    $target = $url !== '' ? outbound_target($url) : 'url';
    if (in_array($target, ['url', 'port', 'private'], true)) {
        $why = ['url' => 'Adresse non vérifiable', 'port' => 'Port non standard : non vérifié', 'private' => 'Adresse du réseau local : non vérifiable depuis le serveur'];
        return ['url' => $url ?: $input, 'status' => 'skip', 'detail' => $why[$target]];
    }
    $domain = base_domain($host);
    $out = ['url' => $url, 'domain' => $domain];
    if ($target === 'dns') {
        return $out + check_missing_host($host, $domain, $deadline);
    }

    $r = check_fetch($url, $deadline);
    $note = '';
    // https en échec (pas de site sur le port 443, certificat expiré) : le site existe peut-être en http
    if (isset($r['error']) && $r['hop'] === 0 && $r['error'] !== 'timeout' && str_starts_with(strtolower($url), 'https:')) {
        $http = check_fetch('http://' . substr($url, 8), $deadline);
        if (isset($http['code'])) {
            [$r, $note] = [$http, ', mais uniquement en http (https : ' . lcfirst(CHECK_REASONS[$r['error']] ?? 'erreur de connexion') . ')'];
        }
    }
    if (isset($r['error'])) {
        $to = strtolower((string) parse_url($r['url'], PHP_URL_HOST));
        if ($r['hop'] > 0) {
            $why = ['dns' => "qui n'existe pas", 'private' => 'sur le réseau local', 'port' => 'sur un port non standard', 'url' => 'adresse non web'][$r['error']] ?? 'injoignable';
            // redirection vers une application ou le réseau interne : le site, lui, a répondu
            $status = in_array($r['error'], ['url', 'private', 'port'], true) ? 'ok' : 'down';
            return $out + ['status' => $status, 'final' => $r['url'], 'detail' => "Redirige vers $to, $why"];
        }
        return $out + ['status' => 'down', 'detail' => CHECK_REASONS[$r['error']] ?? 'Erreur de connexion'];
    }

    $code = $r['code'];
    $out += ['code' => $code] + ($r['url'] !== $url ? ['final' => $r['url']] : []);
    $finalHost = strtolower((string) parse_url($r['url'], PHP_URL_HOST));
    if ($code === 404 || $code === 410) {
        // page profonde introuvable : la page d'accueil du site répond-elle encore ?
        $f = parse_url($r['url']);
        $deep = ($f['path'] ?? '/') !== '/' || isset($f['query']);
        $root = $deep ? check_fetch(strtolower($f['scheme']) . "://$finalHost/", $deadline) : null;
        $alive = isset($root['code']) && $root['code'] < 400;
        return $out + ['status' => 'notfound', 'root' => $root['code'] ?? null,
            'detail' => $alive ? "Page introuvable ($code), mais le site répond : l'adresse a sans doute changé" : "Page introuvable ($code)"];
    }
    // 401, 403, 429 : le site existe mais protège l'accès ou refuse les robots
    if ($code < 400 || in_array($code, [401, 403, 405, 429], true)) {
        if (base_domain($finalHost) !== $domain) {
            return $out + ['status' => 'moved', 'detail' => "Redirige vers $finalHost$note"];
        }
        $detail = $code < 400 ? 'Le site répond' : "Le site répond mais protège l'accès ($code)";
        return $out + ['status' => 'ok', 'detail' => $detail . $note];
    }
    $detail = $code >= 500 ? "Erreur du serveur ($code), souvent passagère" : "Le site répond par une erreur ($code)";
    return $out + ['status' => 'error', 'detail' => $detail . $note];
}
