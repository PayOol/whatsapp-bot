# WhatsApp Link Guard Bot

Plateforme web de gestion de bots WhatsApp basee sur Baileys. Elle protege les groupes contre les liens, gere les avertissements, les bannissements, les appels, les menus textuels, les annonces, les sessions utilisateurs et l'administration web.

## Fonctionnalites principales

- Detection automatique des liens HTTP/HTTPS, domaines, `wa.me` et invitations `chat.whatsapp.com`.
- Suppression des messages contenant des liens via Baileys.
- Avertissements persistants par groupe et utilisateur.
- Bannissement automatique quand le seuil d'avertissements est atteint.
- Exceptions par groupe, par motif de nom de groupe, par utilisateur et pour les admins.
- Messages de bienvenue configurables.
- Rejet d'appels et blocage temporaire en cas de spam d'appels.
- Multi-sessions WhatsApp avec QR code par utilisateur.
- Interface web utilisateur/admin, authentification, recuperation de mot de passe et mode beta.
- Menus textuels numerotes avec reponses, sous-menus, contacts, liens autorises et webhooks.
- Annonces multi-groupes avec texte, image, apercu de lien et statistiques.
- Abonnements PayOol/LeekPay, notifications d'expiration et deconnexion des sessions expirees.
- Statistiques, journaux, scan manuel et scan automatique planifie.

## Prerequis

- Node.js 20 ou superieur, requis par Baileys 7.
- Un compte WhatsApp ou WhatsApp Business utilisable comme appareil lie.
- Chromium/Chrome uniquement pour la generation de l'image Open Graph du site via Puppeteer.

## Installation

```bash
npm install
npm start
```

Ouvrez ensuite l'interface web, creez une session, puis scannez le QR code avec WhatsApp depuis `Parametres > Appareils lies`.

## Migration Baileys

Le projet utilise maintenant `baileys@^7.0.0-rc13`.

Les anciennes sessions stockees dans `.wwebjs_auth/` ne sont pas reutilisables par Baileys. Les nouvelles sessions sont stockees dans `.baileys_auth/`; il faut donc rescanner un QR code pour chaque session existante.

## Structure utile

```text
index.js              # Serveur Express, logique metier et integration Baileys native
public/               # Interfaces web utilisateur/admin/landing
data/                 # Configuration, logs, sessions et etats persistants
.baileys_auth/        # Sessions WhatsApp Baileys (ignore par git)
og-screenshot.js      # Generation de l'image Open Graph via Puppeteer
```

## Docker

L'image Docker utilise Node 22 et monte les volumes suivants:

- `/app/.baileys_auth` pour les sessions WhatsApp.
- `/app/data` pour les donnees applicatives.
