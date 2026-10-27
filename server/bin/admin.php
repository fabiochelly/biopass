<?php
// Administration en ligne de commande :  php bin/admin.php list | delete <user> | revoke <user>
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    require dirname(__DIR__) . '/src/404.php';
}
const BIOPASS = 1;
require_once dirname(__DIR__) . '/src/lib.php';

[$cmd, $arg] = [$argv[1] ?? '', $argv[2] ?? ''];
switch ($cmd) {
    case 'list':
        foreach (glob(data_path('users/*.php')) ?: [] as $f) {
            $u = read_json($f);
            $v = load_vault($u['user']);
            $n = count(array_filter($v['items'], fn($i) => !$i['del']));
            printf("%-20s %5d entrées  rev %-6d créé le %s\n", $u['user'], $n, $v['rev'], date('Y-m-d', $u['created']));
        }
        break;
    case 'revoke':
        $u = norm_user($arg);
        $user = load_user($u) ?? exit("Utilisateur inconnu\n");
        $user['gen']++;
        save_user($user);
        echo "Sessions de $u révoquées.\n";
        break;
    case 'delete':
        $u = norm_user($arg);
        load_user($u) ?? exit("Utilisateur inconnu\n");
        echo "Supprimer définitivement $u et son coffre ? Tapez le nom pour confirmer : ";
        if (trim((string) fgets(STDIN)) !== $u) {
            exit("Annulé.\n");
        }
        @unlink(user_file($u));
        @unlink(vault_file($u));
        echo "Supprimé (les sauvegardes restent dans data/backups/$u).\n";
        break;
    default:
        echo "Usage : php bin/admin.php list | revoke <user> | delete <user>\n";
}
