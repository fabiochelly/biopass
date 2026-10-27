# BioPass — protocole (v1)

Référence commune pour le serveur PHP, l'app web, l'app Rust et l'extension.
**Le serveur ne voit jamais de donnée en clair** : il stocke des blobs chiffrés
et un hash de la clé d'authentification. Tout (dé)chiffrement est côté client.

## 1. Cryptographie

Notations : `b64` = base64 standard **avec** padding. Chaînes en UTF-8.

```
password   = NFC(mot de passe maître)
salt       = 16 octets aléatoires (par utilisateur, stocké sur le serveur)
iter       = itérations PBKDF2 (≥ 600 000, stocké sur le serveur)

masterKey  = PBKDF2-HMAC-SHA256(password, salt, iter, 32 octets)
authKey    = HKDF-SHA256(ikm=masterKey, salt=vide, info="biopass/auth", 32 octets)
wrapKey    = HKDF-SHA256(ikm=masterKey, salt=vide, info="biopass/wrap", 32 octets)

vaultKey   = 32 octets aléatoires, générés une fois à l'inscription
```

- `auth` envoyé au serveur = `b64(authKey)`. Le serveur stocke `password_hash(auth)`.
- `wrapped` = `b64(iv[12] || AES-256-GCM(wrapKey, vaultKey, aad="biopass/vaultkey"))`
  (60 octets décodés : 12 IV + 32 + 16 tag).
- Chaque entrée : `enc` = `b64(iv[12] || AES-256-GCM(vaultKey, JSON(entrée), aad="biopass/item/" + id))`.
  L'AAD lie le chiffré à son id : impossible d'échanger deux entrées côté serveur.
- `id` = 16 octets aléatoires en hexadécimal minuscule (32 caractères).

Changer le mot de passe maître = nouveau salt + nouveau `wrapped` ; les entrées
ne sont pas rechiffrées (la `vaultKey` ne change pas).

### Entrée (JSON en clair, avant chiffrement)

```json
{
  "type": "login",            // "login" | "note"
  "name": "GitHub",
  "username": "fabio",
  "password": "…",
  "uris": ["https://github.com/login"],
  "totp": "otpauth://totp/…  ou secret base32",
  "notes": "",
  "folder": "Dev",
  "fav": false,
  "fields": [{"name": "PIN", "value": "1234", "hidden": true}],
  "history": [{"password": "ancien", "date": 1729000000000}],  // 10 derniers, le plus récent d'abord
  "created": 1730000000000,   // ms epoch
  "updated": 1730000000000
}
```

Tous les champs sont optionnels à la lecture (un client doit tolérer les champs
absents et **conserver les champs inconnus** lors d'une modification).

### Correspondance de domaine

Une entrée correspond à une page si le *domaine de base* d'une de ses `uris`
est égal à celui de la page. Domaine de base = 2 derniers labels du nom d'hôte,
ou 3 si les 2 derniers sont un suffixe connu (`co.uk`, `com.au`, `gouv.fr`…).
Les IP sont comparées telles quelles. Une URI sans schéma est préfixée par `https://`.

## 2. API HTTP

**Clé d'accès (optionnelle)** : si le serveur en a une, toute requête sans elle reçoit un 404
indiscernable d'une page inexistante. L'adresse saisie par l'utilisateur est alors
`https://hote/chemin/?k=<clé>` ; le client en extrait la base (`https://hote/chemin`) et envoie
`X-BP-Key: <clé>` à chaque requête (voir `parseServer` dans core.js). Le navigateur, lui,
reçoit un cookie `bpk` (HttpOnly, limité au chemin) à la première visite avec `?k=`.

Point d'entrée unique : `api.php?a=<action>`. JSON en entrée/sortie.
Authentification par l'en-tête `X-BP-Token: <token>` (pas `Authorization`,
souvent filtré par Apache/FPM). Erreur : code HTTP ≠ 2xx et `{"error": "message"}`.

| Action | Méthode | Corps / query | Réponse |
|---|---|---|---|
| `prelogin` | POST | `{user}` | `{salt, iter}` (valeurs factices déterministes si l'utilisateur n'existe pas) |
| `register` | POST | `{user, code, salt, iter, auth, wrapped}` | comme `login` |
| `login` | POST | `{user, auth}` | `{user, token, salt, iter, wrapped}` |
| `sync` | GET | `&since=<rev>` + token | `{rev, full, items:[{id, rev, enc, del}]}` |
| `save` | POST | `{changes:[{id, prev, enc} \| {id, prev, del:true}]}` + token | `{rev}` ou 409 `{error, conflicts:[id]}` |
| `password` | POST | `{auth, salt, iter, auth_new, wrapped}` + token | `{token}` (invalide les autres sessions) |
| `revoke` | POST | `{}` + token | `{token}` (déconnecte toutes les autres sessions) |

- `user` : `[a-z0-9][a-z0-9._-]{0,31}` (normalisé en minuscules).
- **Révisions** : le coffre a un compteur `rev` global ; chaque entrée porte la `rev`
  de sa dernière modification. `sync&since=N` renvoie les entrées modifiées après N
  (y compris suppressions `del:true, enc:null`). Si `since=0` ou `since > rev`
  serveur, `full:true` : le client **remplace** tout son cache.
- **save** : `prev` = la `rev` de l'entrée sur laquelle le client a basé sa
  modification (0 pour une création ; une entrée supprimée compte comme inexistante, `prev = 0` la
  recrée avec le même `id`, ce que fait la restauration d'une sauvegarde). Si une seule `prev` ne correspond pas,
  rien n'est appliqué (atomique) → 409. Le client doit resynchroniser.
  Après un `save`, le client fait un `sync` pour mettre à jour son cache.
- Token : valable 7 jours (configurable). 401 → refaire `login`.
- `login`/`register` limités par IP (10 échecs / 15 min → 429).

## 3. Flux client

**Déverrouillage** (en ligne d'abord, hors-ligne en repli) :
1. `prelogin(user)` → salt, iter ; dériver les clés ; `login(user, auth)` → token, wrapped.
2. Si le serveur est injoignable : utiliser salt/iter/wrapped du cache local (lecture seule).
3. Déchiffrer `wrapped` avec `wrapKey` (échec GCM = mauvais mot de passe) → `vaultKey`.
4. `sync(since=rev locale)`, mettre à jour le cache chiffré, déchiffrer en mémoire.

Le cache local ne contient **que** des données chiffrées + salt/iter/wrapped.
Hors-ligne = lecture seule. Le serveur est la source de vérité.

## 4. Stockage serveur (dossier `data/`)

Chaque fichier est un `.php` dont la première ligne est une garde (404 puis `exit`), suivie du JSON
(encodé avec `JSON_HEX_TAG`) : le dossier peut se trouver sous la racine web sans rien exposer.

```
data/secret.php                  {key: 32 octets en hexadécimal} (signature des tokens)
data/users/<user>.php            {user, salt, iter, auth(hash), wrapped, gen, created}
data/vaults/<user>.php           {rev, items:{<id>:{rev, enc, del}}}
data/locks/<nom>.php             verrous flock (garde seule)
data/backups/<user>/<date>.php   instantané quotidien {user, vault} (30 jours)
data/ratelimit/<sha256(ip)>.php
```

Écritures atomiques (fichier temporaire + fsync + rename) sous verrou exclusif.

## 5. Recherche approximative (identique sur tous les clients)

Référence : `search` dans `server/web/assets/core.js` ; jeu de test : `tools/search-vectors.json`
(régénéré par `node tools/make-search-vectors.mjs`), à reproduire **à l'identique, ordre compris**.

- `fold(s)` : minuscules, `œ`→`oe`, `æ`→`ae`, décomposition NFD puis suppression des diacritiques (U+0300–U+036F).
- Champs et poids : `name` ×1 ; `both` ×0,9 (`name + ' ' + username`) et `rev` ×0,9 (`username + ' ' + name`),
  vides si pas d'identifiant : « applis » et « lisapple » → titre « Apple » + identifiant « lisa » ; `host` ×0,8 (hôtes des `uris`, sans `www.`, joints par une espace) ;
  `username` ×0,7 ; `folder` ×0,5. Tous passés par `fold`.
- Requête : `fold(q)` découpée sur les espaces ; **chaque** terme doit correspondre à au moins un champ.
- Score d'un terme `t` dans un champ `f` (séparateurs = tout caractère hors `[a-z0-9]`) :
  - 100 si `f` commence par `t` ; 90 si `t` apparaît en début de mot ; 70 si `t` est une sous-chaîne ailleurs ;
  - sinon, si `len(t) ≥ 3` : lettres de `t` dans l'ordre, la première en début de mot, sur une étendue
    `span ≤ 3 × len(t)` (correspondance gloutonne à partir de chaque début de mot candidat) :
    `round(30 + 30 × len(t) / span)`, on garde le meilleur ;
  - sinon, si `len(t) ≥ 4` : 40 si la distance de Damerau-Levenshtein (transpositions adjacentes)
    entre `t` et un mot de `f` (de longueur ≥ 2), ou entre `t` et le préfixe de même longueur d'un mot
    plus long, est ≤ 1 (≤ 2 si `len(t) ≥ 8`) ;
  - sinon 0.
- Découpe titre/identifiant (`splitScore`, si `len(t) ≥ 4` et un identifiant existe) : 80 s'il existe `k`
  (2 ≤ k ≤ len(t) − 2) tel que `t[0:k]` commence un mot de l'identifiant (ou, si k ≥ 3, apparaît n'importe où
  dans l'identifiant) et `t[k:]` commence un mot du nom,
  ou l'inverse (mots = découpage sur les séparateurs, vides ignorés) ; compte avec le poids 0,9.
  Ex. « lisapp » → « lis » (lisamartin@icloud.example) + « app » (Apple).
- Score de l'entrée = Σ sur les termes du meilleur `score × poids` parmi les champs (et la découpe) (0 si un terme ne
  correspond nulle part → entrée exclue), + 5 si favorite.
- Tri : score décroissant, puis `fold(name)` par ordre des points de code. Requête vide : toutes les
  entrées, favorites d'abord (score 1, sinon 0), puis par `fold(name)`.
