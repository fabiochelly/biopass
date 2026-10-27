<?php
// BioPass — API (voir PROTOCOL.md).
declare(strict_types=1);

const BIOPASS = 1;
require __DIR__ . '/src/lib.php';

// L'ouverture d'un partage (Send) est publique : le destinataire n'a pas la clé d'accès.
// Seul un identifiant de partage existant passe ; tout le reste répond 404 comme d'habitude.
$sendOpen = in_array($_GET['a'] ?? '', ['send_open', 'send_info'], true) && preg_match('/^[A-Za-z0-9_-]{22}$/', (string) ($_GET['s'] ?? ''))
    && is_file(data_path('sends/' . $_GET['s'] . '.php'));
if (!$sendOpen) {
    require_access_key();
}
require __DIR__ . '/src/api.php';
run_api();
