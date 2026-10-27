<?php
// BioPass — relais de favicons. Le navigateur ne peut pas lire l'icône d'un autre site (CORS) :
// le serveur la télécharge à la demande d'un utilisateur connecté et la renvoie telle quelle,
// sans rien conserver. Les clients la réduisent en 64×64 et la stockent chiffrée dans l'entrée.
declare(strict_types=1);
defined('BIOPASS') or require __DIR__ . '/404.php';

const ICON_MAX_PAGE = 512 * 1024;
const ICON_MAX_IMAGE = 256 * 1024;
const ICON_TIMEOUT = 6;
const ICON_SITE_BUDGET = 15; // secondes passées au plus sur le site lui-même
// Navigateur ordinaire : certains sites refusent les robots qui s'annoncent comme tels.
const ICON_DDG_DEFAULT = 'ab1fb25b83d4b333ea661a84bd298b2e'; // icône « globe » générique de DuckDuckGo
const ICON_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Adresse IP publique uniquement : le relais ne doit pas permettre de sonder le réseau du serveur (SSRF).
function public_ips(string $host): array
{
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips = [$host];
    } else {
        $ips = gethostbynamel($host) ?: [];
        foreach (@dns_get_record($host, DNS_AAAA) ?: [] as $r) {
            if (!empty($r['ipv6'])) {
                $ips[] = $r['ipv6'];
            }
        }
    }
    foreach ($ips as $ip) {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return []; // une seule adresse interne suffit à refuser (DNS piégé)
        }
    }
    return $ips;
}

// GET limité en taille et en durée, redirections suivies à la main (chaque saut est revérifié),
// adresse IP épinglée pour qu'un second résolveur DNS ne puisse pas rediriger vers le réseau interne.
// $truncate : au-delà de $max, garder le début (pages HTML : les icônes sont dans l'en-tête) au lieu d'échouer.
function icon_get(string $url, int $max, int $hops = 4, bool $truncate = false): ?array
{
    for ($i = 0; $i <= $hops; $i++) {
        $p = parse_url($url);
        $scheme = strtolower($p['scheme'] ?? '');
        $host = strtolower($p['host'] ?? '');
        // noms seulement (pas d'IP abrégée du type « 169.254 », interprétée comme une adresse par le résolveur)
        $isIp = (bool) filter_var(trim($host, '[]'), FILTER_VALIDATE_IP);
        if (!in_array($scheme, ['http', 'https'], true) || $host === '' || $host === 'localhost' || isset($p['user'])
            || (!$isIp && !preg_match('#^(?=.*[a-z])[a-z0-9.-]+$#', $host))) {
            return null;
        }
        $ips = public_ips($host);
        if (!$ips) {
            return null;
        }
        $port = $p['port'] ?? ($scheme === 'https' ? 443 : 80);
        if (!in_array($port, [80, 443], true)) {
            return null;
        }
        $body = '';
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RESOLVE => ["$host:$port:" . (str_contains($ips[0], ':') ? "[{$ips[0]}]" : $ips[0])],
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT => ICON_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_USERAGENT => ICON_UA,
            CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml,image/avif,image/webp,image/*;q=0.9,*/*;q=0.8', 'Accept-Language: fr-FR,fr;q=0.9,en;q=0.8'],
            CURLOPT_ENCODING => '',
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_HEADER => false,
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$body, $max) {
                $body .= $chunk;
                return strlen($body) > $max ? 0 : strlen($chunk); // coupe au-delà de la limite
            },
        ]);
        curl_exec($ch);
        $truncated = strlen($body) > $max;
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $type = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $location = (string) curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        $final = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        curl_close($ch);
        if ($code >= 300 && $code < 400 && $location !== '') {
            $url = $location;
            continue;
        }
        if ($code !== 200 || $body === '' || ($truncated && !$truncate)) {
            return null;
        }
        $body = substr($body, 0, $max);
        return ['body' => $body, 'type' => strtolower($type), 'url' => $final ?: $url];
    }
    return null;
}

function resolve_url(string $base, string $href): string
{
    $href = html_entity_decode(trim($href), ENT_QUOTES | ENT_HTML5);
    if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $href)) {
        return $href;
    }
    $b = parse_url($base);
    $origin = $b['scheme'] . '://' . $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '');
    if (str_starts_with($href, '//')) {
        return $b['scheme'] . ':' . $href;
    }
    if (str_starts_with($href, '/')) {
        return $origin . $href;
    }
    $dir = preg_replace('#/[^/]*$#', '/', $b['path'] ?? '/');
    return $origin . $dir . $href;
}

// Icônes déclarées dans la page, de la plus intéressante à la moins intéressante
// (apple-touch-icon puis grandes tailles ; le SVG en dernier : tous les clients ne savent pas le lire).
function page_icons(string $html, string $base): array
{
    $found = [];
    if (!preg_match_all('#<link\b[^>]*>#i', substr($html, 0, ICON_MAX_PAGE), $tags)) {
        return [];
    }
    foreach ($tags[0] as $tag) {
        $attr = [];
        preg_match_all('#([a-z-]+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))#i', $tag, $m, PREG_SET_ORDER | PREG_UNMATCHED_AS_NULL);
        foreach ($m as $a) {
            $attr[strtolower($a[1])] = $a[2] ?? $a[3] ?? $a[4] ?? '';
        }
        $rel = strtolower($attr['rel'] ?? '');
        if (empty($attr['href']) || !preg_match('#\b(icon|apple-touch-icon(-precomposed)?)\b#', $rel) || str_contains($rel, 'mask-icon')) {
            continue;
        }
        $size = 0;
        if (preg_match('#(\d+)x\d+#', $attr['sizes'] ?? '', $s)) {
            $size = (int) $s[1];
        }
        if (str_contains($rel, 'apple-touch-icon')) {
            $size = max($size, 180);
        }
        $svg = str_contains($attr['type'] ?? '', 'svg') || preg_match('#\.svg(\?|$)#i', $attr['href']);
        $score = $svg ? 1 : ($size >= 32 ? 1000 + min($size, 256) : 100 + $size);
        $found[] = [$score, resolve_url($base, $attr['href'])];
    }
    usort($found, fn($a, $b) => $b[0] <=> $a[0]);
    return array_values(array_unique(array_column($found, 1)));
}

function image_type(string $body): ?string
{
    return match (true) {
        str_starts_with($body, "\x89PNG") => 'image/png',
        str_starts_with($body, "\xFF\xD8\xFF") => 'image/jpeg',
        str_starts_with($body, 'GIF8') => 'image/gif',
        str_starts_with($body, "\0\0\1\0") => 'image/x-icon',
        str_starts_with($body, 'RIFF') && substr($body, 8, 4) === 'WEBP' => 'image/webp',
        str_starts_with($body, 'BM') => 'image/bmp',
        (bool) preg_match('#^\s*(<\?xml[^>]*>\s*)?(<!--.*?-->\s*)*(<!doctype[^>]*>\s*)?<svg\b#is', substr($body, 0, 2048)) => 'image/svg+xml',
        default => null,
    };
}

// Côté (en pixels) d'une image : PNG, ICO (plus grande entrée), GIF, WebP, JPEG ; SVG = vectoriel (net à toute taille).
function image_size(string $b, string $type): int
{
    switch ($type) {
        case 'image/svg+xml':
            return 10000;
        case 'image/png':
            return strlen($b) >= 24 ? min(unpack('N2', substr($b, 16, 8))) : 0;
        case 'image/x-icon':
            $n = strlen($b) >= 6 ? unpack('v', substr($b, 4, 2))[1] : 0;
            $max = 0;
            for ($i = 0; $i < $n && 6 + 16 * $i + 1 < strlen($b); $i++) {
                $max = max($max, ord($b[6 + 16 * $i]) ?: 256);
            }
            return $max;
        case 'image/gif':
            return strlen($b) >= 10 ? min(unpack('v2', substr($b, 6, 4))) : 0;
        case 'image/webp':
            $chunk = substr($b, 12, 4);
            if ($chunk === 'VP8X' && strlen($b) >= 30) {
                return min(1 + (ord($b[24]) | ord($b[25]) << 8 | ord($b[26]) << 16), 1 + (ord($b[27]) | ord($b[28]) << 8 | ord($b[29]) << 16));
            }
            if ($chunk === 'VP8 ' && strlen($b) >= 30) {
                return min(unpack('v', substr($b, 26, 2))[1] & 0x3fff, unpack('v', substr($b, 28, 2))[1] & 0x3fff);
            }
            if ($chunk === 'VP8L' && strlen($b) >= 25) {
                $v = unpack('V', substr($b, 21, 4))[1];
                return min(($v & 0x3fff) + 1, (($v >> 14) & 0x3fff) + 1);
            }
            return 64;
        case 'image/jpeg':
            for ($i = 2; $i + 9 < strlen($b);) {
                if (ord($b[$i]) !== 0xFF) {
                    break;
                }
                $m = ord($b[$i + 1]);
                if ($m >= 0xC0 && $m <= 0xC3) {
                    return min(unpack('n2', substr($b, $i + 5, 4)));
                }
                $i += 2 + unpack('n', substr($b, $i + 2, 2))[1];
            }
            return 0;
    }
    return 0;
}

// Icônes du manifeste d'application web (<link rel="manifest">) : souvent 192 ou 512 px.
function manifest_icons(string $html, string $base): array
{
    if (!preg_match('#<link\b[^>]*rel\s*=\s*["\']?manifest["\'\s>][^>]*>#i', $html, $m) || !preg_match('#href\s*=\s*["\']?([^"\'\s>]+)#i', $m[0], $h)) {
        return [];
    }
    $url = resolve_url($base, $h[1]);
    $r = icon_get($url, 128 * 1024);
    $json = $r ? json_decode($r['body'], true) : null;
    $out = [];
    foreach (is_array($json['icons'] ?? null) ? $json['icons'] : [] as $icon) {
        if (!is_array($icon) || empty($icon['src']) || str_contains((string) ($icon['purpose'] ?? ''), 'monochrome')) {
            continue;
        }
        preg_match('#(\d+)x\d+#', (string) ($icon['sizes'] ?? ''), $sz);
        $out[] = [(int) ($sz[1] ?? 0), resolve_url($r['url'], (string) $icon['src'])];
    }
    usort($out, fn($a, $b) => $b[0] <=> $a[0]);
    return array_column(array_slice($out, 0, 2), 1);
}

// URL d'un site → ['type' => …, 'body' => octets] ou null.
// Toutes les sources raisonnables sont comparées et la plus grande est retenue (le SVG d'abord).
function fetch_favicon(string $siteUrl): ?array
{
    $p = parse_url(preg_match('#^https?://#i', $siteUrl) ? $siteUrl : "https://$siteUrl");
    $host = strtolower($p['host'] ?? '');
    if ($host === '') {
        return null;
    }
    require_once __DIR__ . '/icons.php';
    if ($icon = builtin_icon($host)) {
        return $icon;
    }
    // l'hôte exact, puis son domaine de base (accounts.google.com → google.com)
    $hosts = [$host];
    $parts = explode('.', $host);
    if (count($parts) > 2 && !filter_var($host, FILTER_VALIDATE_IP)) {
        $hosts[] = implode('.', array_slice($parts, -2));
    }
    // pages particulières (config 'icon_pages' : domaine => adresse de la page qui porte l'icône)
    $pages = [];
    foreach ((array) (config()['icon_pages'] ?? []) as $domain => $page) {
        if ($host === $domain || str_ends_with($host, ".$domain")) {
            $pages[] = $page;
        }
    }
    $best = null;
    $bestSize = 0;
    // un site lent ne doit pas bloquer la requête : au-delà, on passe aux services d'icônes (rapides)
    $deadline = microtime(true) + ICON_SITE_BUDGET;
    foreach (array_unique($hosts) as $h) {
        if (microtime(true) > $deadline) {
            break;
        }
        $candidates = [];
        foreach ([...$pages, "https://$h/"] as $pageUrl) {
            if (microtime(true) > $deadline) {
                break;
            }
            $page = icon_get($pageUrl, ICON_MAX_PAGE, 4, true) ?? ($pageUrl === "https://$h/" ? icon_get("http://$h/", ICON_MAX_PAGE, 4, true) : null);
            if ($page && str_contains($page['type'], 'html')) {
                $candidates = [...$candidates, ...array_slice(page_icons($page['body'], $page['url']), 0, 4), ...manifest_icons($page['body'], $page['url'])];
            }
        }
        $candidates[] = "https://$h/apple-touch-icon.png";
        $candidates[] = "https://$h/favicon.ico";
        foreach (array_slice(array_values(array_unique($candidates)), 0, 8) as $url) {
            if (microtime(true) > $deadline) {
                break;
            }
            $img = icon_get($url, ICON_MAX_IMAGE);
            $type = $img ? image_type($img['body']) : null;
            $size = $type ? image_size($img['body'], $type) : 0;
            if ($type && $size > $bestSize) {
                [$best, $bestSize] = [['type' => $type, 'body' => $img['body']], $size];
            }
            if ($bestSize >= 128) {
                return $best; // assez grand : inutile de chercher plus
            }
        }
        if ($best) {
            break;
        }
    }
    // Services d'icônes (ne reçoivent que le nom de domaine). Désactivable : 'icon_fallback' => false.
    if (!(config()['icon_fallback'] ?? true)) {
        return $best;
    }
    // Icône du site plus petite que les 128 px stockés (google.com, meta.com n'annoncent que du 32 px) : le
    // service de Google en connaît souvent une version 128 px nette. Réponse 404 pour un site qu'il ne connaît pas.
    if ($bestSize < 128) {
        foreach (array_unique($hosts) as $h) {
            $img = icon_get('https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=' . rawurlencode("https://$h"), ICON_MAX_IMAGE);
            $type = $img ? image_type($img['body']) : null;
            $size = $type ? image_size($img['body'], $type) : 0;
            if ($type && $size > $bestSize) {
                [$best, $bestSize] = [['type' => $type, 'body' => $img['body']], $size];
            }
            if ($bestSize >= 128) {
                break;
            }
        }
    }
    if ($best) {
        return $best;
    }
    // Dernier recours : service d'icônes de DuckDuckGo.
    foreach (array_unique($hosts) as $h) {
        $img = icon_get('https://icons.duckduckgo.com/ip3/' . rawurlencode($h) . '.ico', ICON_MAX_IMAGE);
        $type = $img ? image_type($img['body']) : null;
        // l'icône générique « globe » de DuckDuckGo (site inconnu) n'est pas une vraie icône
        if ($type && strlen($img['body']) > 200 && md5($img['body']) !== ICON_DDG_DEFAULT) {
            return ['type' => $type, 'body' => $img['body']];
        }
    }
    return null;
}
