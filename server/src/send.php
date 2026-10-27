<?php
// BioPass — « Send » : partages chiffrés de bout en bout.
// Le client chiffre le contenu avec une clé qui reste dans le fragment du lien (#…) ; le serveur ne
// stocke que le chiffré, une preuve d'accès hachée, l'expiration et le compteur de consultations.
declare(strict_types=1);
defined('BIOPASS') or require __DIR__ . '/404.php';

const SEND_MAX_TTL = 30 * 86400;
const SEND_MAX_VIEWS = 100;
const SEND_MAX_ATTEMPTS = 5;   // codes faux avant destruction
const SEND_KEEP_EXPIRED = 7 * 86400; // un lien expiré affiche « n'est plus disponible » pendant 7 jours

function send_id_ok(mixed $id): bool
{
    return is_string($id) && (bool) preg_match('/^[A-Za-z0-9_-]{22}$/', $id);
}

function send_file(string $id): string
{
    return data_path("sends/$id.php");
}

function load_send(string $id): ?array
{
    return send_id_ok($id) ? read_json(send_file($id)) : null;
}

// Disponible = existe, pas expiré, consultations restantes, contenu présent.
function send_alive(array $s): bool
{
    return $s['enc'] !== null && $s['expires'] > time() && ($s['max_views'] === 0 || $s['views'] < $s['max_views']);
}

// Retire le contenu d'un partage terminé (le fichier reste un temps pour afficher un message clair).
function send_purge(): void
{
    foreach (glob(data_path('sends/*.php')) ?: [] as $f) {
        if (basename($f) === 'index.php') {
            continue;
        }
        $s = read_json($f);
        if ($s && $s['expires'] + SEND_KEEP_EXPIRED < time()) {
            @unlink($f);
        } elseif ($s && $s['enc'] !== null && !send_alive($s)) {
            $s['enc'] = null;
            write_json($f, $s);
        }
    }
}

function smtp_configured(): bool
{
    $c = config()['smtp'] ?? null;
    return is_array($c) && !empty($c['host']) && !empty($c['from']);
}

// Client SMTP minimal (STARTTLS ou SSL, AUTH LOGIN) : pas de dépendance.
function smtp_send(string $to, string $subject, string $text, string $html): void
{
    $c = config()['smtp'];
    $secure = $c['secure'] ?? 'tls';
    $port = (int) ($c['port'] ?? ($secure === 'ssl' ? 465 : 587));
    $remote = ($secure === 'ssl' ? 'ssl://' : 'tcp://') . $c['host'] . ':' . $port;
    $ctx = stream_context_create(['ssl' => ['verify_peer' => !empty($c['verify'] ?? true), 'verify_peer_name' => !empty($c['verify'] ?? true)]]);
    $fp = @stream_socket_client($remote, $errno, $errstr, 10, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) {
        throw new ApiError(502, "Serveur SMTP injoignable ($errstr)");
    }
    stream_set_timeout($fp, 15);
    $read = function () use ($fp): string {
        $out = '';
        while (($line = fgets($fp, 1024)) !== false) {
            $out .= $line;
            if (strlen($line) < 4 || $line[3] === ' ') {
                break;
            }
        }
        return $out;
    };
    $cmd = function (?string $line, array $ok) use ($fp, $read): string {
        if ($line !== null) {
            fwrite($fp, $line . "\r\n");
        }
        $resp = $read();
        if (!in_array((int) substr($resp, 0, 3), $ok, true)) {
            throw new ApiError(502, 'Erreur SMTP : ' . trim(strtok($resp, "\n") ?: 'pas de réponse'));
        }
        return $resp;
    };
    try {
        $host = gethostname() ?: 'biopass';
        $cmd(null, [220]);
        $cmd("EHLO $host", [250]);
        if ($secure === 'tls') {
            $cmd('STARTTLS', [220]);
            if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new ApiError(502, 'Échec STARTTLS');
            }
            $cmd("EHLO $host", [250]);
        }
        if (!empty($c['user'])) {
            $cmd('AUTH LOGIN', [334]);
            $cmd(base64_encode((string) $c['user']), [334]);
            $cmd(base64_encode((string) ($c['pass'] ?? '')), [235]);
        }
        preg_match('/<([^>]+)>/', $c['from'], $m);
        $fromAddr = $m[1] ?? $c['from'];
        $cmd("MAIL FROM:<$fromAddr>", [250]);
        $cmd("RCPT TO:<$to>", [250, 251]);
        $cmd('DATA', [354]);
        $boundary = 'bp' . bin2hex(random_bytes(8));
        $enc = fn(string $s) => '=?UTF-8?B?' . base64_encode($s) . '?=';
        $fromHeader = preg_match('/^(.*?)\s*<([^>]+)>$/', $c['from'], $fm) ? $enc(trim($fm[1], ' "')) . " <{$fm[2]}>" : $c['from'];
        $headers = [
            "From: $fromHeader",
            "To: <$to>",
            'Subject: ' . $enc($subject),
            'Date: ' . date('r'),
            'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . (explode('@', $fromAddr)[1] ?? 'biopass') . '>',
            'MIME-Version: 1.0',
            "Content-Type: multipart/alternative; boundary=\"$boundary\"",
        ];
        $body = implode("\r\n", $headers) . "\r\n\r\n"
            . "--$boundary\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($text))
            . "--$boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($html))
            . "--$boundary--";
        $cmd(str_replace("\r\n.", "\r\n..", $body) . "\r\n.", [250]);
        $cmd('QUIT', [221]);
    } finally {
        fclose($fp);
    }
}
