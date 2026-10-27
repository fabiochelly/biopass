# BioPass pour Android

Application Android de BioPass : coffre hors ligne en lecture seule, déverrouillage par
empreinte, et surtout **service de saisie automatique** (comme Bitwarden) pour remplir les
identifiants dans les applications et les navigateurs.

- Android 9 (API 28) minimum, cible Android 15 (API 35).
- Une seule dépendance, `androidx.autofill` (suggestions dans la barre du clavier) : APK d'environ 210 Kio, démarrage instantané.
- Même protocole et même cryptographie que l'app web (`../PROTOCOL.md`) : le serveur ne voit
  jamais rien en clair.

## Compilation (Docker uniquement)

Rien à installer sur la machine à part Docker. Le SDK Android et le cache Gradle sont gardés
dans le volume Docker `biopass-android-cache` (premier build : quelques minutes de téléchargement).

```sh
./build.sh          # APK release signée → dist/biopass.apk
./build.sh test     # tests unitaires JVM (crypto, TOTP, domaines, détection des champs…)
./tools/integration-test.sh   # test contre un vrai serveur PHP + core.js (nécessite php et node sur l'hôte)
```

Pour tout effacer : `docker volume rm biopass-android-cache`.

(`./build.sh gradle :app:assembleRelease -PnoSecure` produit une APK *de test* sans
`FLAG_SECURE`, uniquement pour faire des captures d'écran dans un émulateur.)

### Clé de signature — À SAUVEGARDER

Au premier build, `build.sh` crée `signing/biopass.jks` et `signing/keystore.properties`
(mot de passe aléatoire). Ce dossier est ignoré par git.

**Sauvegardez le dossier `signing/`** (gestionnaire de mots de passe, clé USB…) : Android
n'installe une mise à jour par-dessus l'ancienne version que si elle est signée avec la même
clé. Sans elle, il faudra désinstaller l'app (et la reconfigurer) sur chaque téléphone.

## Installation

L'APK s'installe à la main (pas de Play Store) :

- câble USB + débogage activé : `adb install -r dist/biopass.apk` ;
- ou transférez `dist/biopass.apk` sur le téléphone (Drive, mail, câble…) et ouvrez-le ; Android
  demande d'autoriser l'installation depuis cette source.

Au premier lancement : adresse du serveur, identifiant et mot de passe maître. Le compte se
crée depuis le site web. Si le serveur est protégé par une clé d'accès, saisissez l'adresse
complète affichée par le site, par ex. `https://example.com/biopass/?k=GUID` : la clé est
envoyée dans l'en-tête `X-BP-Key`, conservée dans le cache local, mais jamais affichée (seule
l'adresse de base l'est). Sans clé valide, l'app indique « Serveur introuvable ou clé d'accès
incorrecte ».

## Saisie automatique

1. Paramètres d'Android → **Mots de passe et comptes** (ou *Système → Langues et saisie →
   Service de saisie automatique*, selon le téléphone) → **Service de saisie automatique** →
   **BioPass**. Raccourci : BioPass → Paramètres → *Choisir BioPass*.
2. **Chrome et Brave** (versions récentes) : dans le navigateur, *Paramètres → Saisie automatique*
   (Chrome : *Paramètres → Saisie automatique et mots de passe*) → choisir
   **« Saisie automatique via un autre service »**, puis redémarrer le navigateur. Sans ce réglage,
   ils n'utilisent que leur propre gestionnaire. Firefox utilise directement le service Android.

Fonctionnement :

- en touchant un champ identifiant / mot de passe / code, BioPass propose les entrées dont une
  URI correspond : même *domaine de base* que la page (navigateurs), ou
  `androidapp://<paquet>` pour une application (format Bitwarden, conservé à l'import) ;
- coffre verrouillé : la suggestion « BioPass verrouillé » ouvre le déverrouillage (empreinte ou
  mot de passe), puis les suggestions apparaissent ;
- **« Rechercher dans BioPass… »** est toujours proposé : choisissez une entrée à la main ; si
  elle n'est pas encore associée à l'application ou au site, BioPass propose de l'y associer
  (ajout de l'URI) pour la suggérer directement la fois suivante ;
- Android 11+ avec un clavier compatible (Gboard, Samsung…) : suggestions compactes dans la barre
  du clavier (identifiant seul, nom ajouté seulement pour départager deux entrées), loupe « Rechercher »
  épinglée à droite ; sinon liste déroulante compacte. Juste après un déverrouillage, Android affiche
  parfois la liste déroulante au lieu de la barre du clavier ;
- formulaire en deux étapes (identifiant seul) : la suggestion remplit l'identifiant ;
- après une connexion avec un nouveau mot de passe, Android propose « Enregistrer dans BioPass » :
  l'entrée de même identifiant pour ce site / cette application est mise à jour (l'ancien mot de
  passe va dans l'historique), sinon une entrée est créée. Il faut être en ligne. Si BioPass est
  verrouillé à ce moment-là, Android 14+ empêche souvent d'afficher le déverrouillage : un message
  le signale et BioPass propose l'enregistrement à sa prochaine ouverture (demande gardée
  10 minutes en mémoire seulement) ;
- les écrans système (code PIN du téléphone, etc.) sont ignorés.

## Empreinte

Proposée après le premier déverrouillage, ou dans Paramètres. La clé du coffre (et la clé
d'authentification, pour obtenir une nouvelle session sans mot de passe) est chiffrée par une
clé du Keystore Android qui exige une empreinte (biométrie « forte ») à chaque usage. Elle est
**invalidée automatiquement si une nouvelle empreinte est enregistrée** sur le téléphone, ou si
le mot de passe maître est changé ailleurs : il faut alors saisir le mot de passe puis réactiver.

## Sécurité et hors ligne

- Clé du coffre uniquement en mémoire ; verrouillage automatique après 5 min d'inactivité
  (réglable : 1, 5, 15, 60 min ou jamais), bouton cadenas pour verrouiller tout de suite.
- « Jamais » : la clé du coffre et l'auth sont conservées chiffrées par une clé du Keystore liée au
  téléphone (sans empreinte), le coffre reste ouvert même après un redémarrage et se reconnecte seul.
  Protégez alors le téléphone par un code. Un verrouillage manuel efface cette conservation ; si le
  mot de passe maître a changé ailleurs, BioPass se verrouille.
- Cache local (`files/cache.json`) : uniquement des données chiffrées + salt/itérations/clé
  enveloppée, jamais de clair ni de jeton de session. Sauvegarde Android désactivée.
- Hors ligne : déverrouillage depuis le cache, **lecture seule** (et saisie automatique).
- Captures d'écran bloquées (`FLAG_SECURE`) ; copies marquées sensibles (Android 13+, masquées dans
  l'aperçu du presse-papiers). Le presse-papiers n'est jamais vidé automatiquement.
- HTTPS obligatoire (sauf `localhost`).

## Structure

```
app/src/main/java/app/biopass/
  core/          Kotlin pur, testé sur la JVM : Crypto (PBKDF2, HKDF, AES-GCM), Vault + Api,
                 Util (domaines, TOTP, générateur, recherche), Fields (détection des champs)
  App.kt         Session (coffre en mémoire, verrouillage auto), cache fichier, presse-papiers
  Bio.kt         Empreinte (Keystore + BiometricPrompt)
  Ui.kt, UnlockPanel.kt, *Activity.kt   Interface
  autofill/      Service de saisie automatique, analyse de l'AssistStructure, activité
app/src/test/    Tests JVM (vecteurs de test de core.js, intégration serveur)
tools/           Script exécuté dans le conteneur, test d'intégration
```
