<?php
// Réponse 404 identique à celle de nginx pour un fichier .php inexistant (146 octets).
// Incluse par les gardes de tous les fichiers PHP qui ne sont pas des points d'entrée.
header_remove('X-Powered-By');
http_response_code(404);
ini_set('default_charset', '');
header('Content-Type: text/html');
$page = "<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
header('Content-Length: ' . strlen($page));
echo $page;
exit;
