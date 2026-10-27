<?php
// Génère web.php (app web) et downloads.php (APK, extension) à partir du dossier web/.
// Seuls ces deux fichiers sont déployés : le serveur web n'a ainsi que des .php à servir.
//   php bin/build-web.php      (appelé par tools/build-server.sh)
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    require dirname(__DIR__) . '/src/404.php';
}
const BIOPASS = 1;
require dirname(__DIR__) . '/src/lib.php';

$root = dirname(__DIR__);
$bundles = ['web.php' => [], 'downloads.php' => []];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$root/web", FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    $path = substr(str_replace('\\', '/', $f->getPathname()), strlen("$root/web/"));
    if (web_type($path) === null) {
        fwrite(STDERR, "ignoré : web/$path\n");
        continue;
    }
    $bundles[str_starts_with($path, 'downloads/') ? 'downloads.php' : 'web.php'][$path] = base64_encode(file_get_contents($f->getPathname()));
}
foreach ($bundles as $name => $files) {
    ksort($files);
    $php = "<?php\n// Généré par bin/build-web.php à partir de web/ — ne pas modifier.\n"
        . "defined('BIOPASS') or require __DIR__ . '/src/404.php';\n\nreturn " . var_export($files, true) . ";\n";
    file_put_contents("$root/$name.tmp", $php);
    rename("$root/$name.tmp", "$root/$name");
    printf("%-14s %3d fichiers, %s Ko\n", $name, count($files), number_format(strlen($php) / 1024, 0, ',', ' '));
}
