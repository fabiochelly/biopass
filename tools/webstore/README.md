# Publier l'extension sur le Chrome Web Store (non répertoriée)

Une extension « non répertoriée » n'apparaît pas dans les recherches : seules les personnes qui ont
le lien peuvent l'installer, en un clic, avec les mises à jour automatiques (Brave l'accepte aussi).

1. Créer un compte développeur : https://chrome.google.com/webstore/devconsole (5 $ une fois).
2. `tools/build-server.sh` → téléverser **`dist/biopass-extension-webstore.zip`** (« Nouvel élément »).
3. Fiche :
   - **Description** : voir ci-dessous. Catégorie : Outils. Langue : français.
   - **Icône** : `extension/icons/icon-128.png`. **Captures** : `capture-1-remplissage.png`, `capture-2-popup.png`.
   - **Confidentialité** : objectif unique, justification des autorisations et usage des données : voir ci-dessous.
     L'URL de la politique de confidentialité doit être **publique** : publier `confidentialite.html`
     sur un site accessible (pas sous le dossier protégé par la clé), par ex. `https://example.com/confidentialite-biopass.html`.
   - **Distribution** : visibilité **Non répertoriée**.
4. Après validation (quelques jours), mettre le lien de l'extension dans `server/config.php`
   (`'extension_store_url' => 'https://chromewebstore.google.com/detail/…'`), relancer `tools/build-server.sh`
   et déployer : le site affiche alors un bouton « Installer depuis le Chrome Web Store ».

Chaque nouvelle version : augmenter `version` dans `extension/manifest.json`, `tools/build-server.sh`,
téléverser le nouveau zip (et déployer `downloads.php` pour l'installation par politique sous Linux).

## Description

> Remplissage automatique des mots de passe depuis votre propre serveur BioPass.
>
> BioPass est un gestionnaire de mots de passe auto-hébergé : vos données sont chiffrées sur votre appareil
> (AES-256-GCM, clé dérivée de votre mot de passe maître) et stockées sur VOTRE serveur, jamais chez nous.
>
> • Menu de remplissage sous les champs de connexion, raccourci Ctrl+Espace
> • Proposition d'enregistrer ou de mettre à jour un mot de passe après connexion
> • Recherche instantanée tolérante aux fautes, codes 2FA (TOTP), générateur de mots de passe
> • Sécurité : un mot de passe n'est remis qu'aux pages du site correspondant (iframes comprises)
>
> Nécessite un serveur BioPass (adresse fournie par l'administrateur de votre famille).

## Objectif unique

Remplir et enregistrer les identifiants de l'utilisateur sur les sites web, à partir de son coffre BioPass chiffré.

## Justification des autorisations

- **Accès aux sites (`<all_urls>`, script de contenu)** : détecter les formulaires de connexion sur n'importe quel site,
  afficher le menu de remplissage et remplir les champs ; communiquer avec le serveur BioPass de l'utilisateur, dont l'adresse est libre.
- **storage / unlimitedStorage** : conserver le coffre chiffré et les réglages localement (hors ligne).
- **alarms** : verrouillage automatique et synchronisation périodique.
- **clipboardWrite** : copier un identifiant, un mot de passe ou un code 2FA à la demande.
- **contextMenus** : « Remplir avec BioPass » / « Générer un mot de passe » au clic droit dans un champ.

## Usage des données (formulaire « Pratiques de confidentialité »)

- Données traitées : **informations d'authentification** (identifiants, mots de passe) et **contenu de sites web**
  (détection des formulaires), uniquement pour la fonction de remplissage.
- Aucune donnée n'est envoyée au développeur ni à un tiers : les seules communications réseau vont au serveur
  choisi par l'utilisateur, et les données y sont chiffrées de bout en bout.
- Pas de vente, pas d'usage publicitaire, pas d'usage sans rapport avec la fonction, pas d'évaluation de solvabilité.
