# Analyse fonctionnelle complete

Date d'analyse: 2026-06-25.

Ce projet est une plateforme Express + WhatsApp multi-sessions. Le fichier principal est `index.js`; l'integration WhatsApp est maintenant migree directement vers Baileys, sans couche de compatibilite avec l'ancienne bibliotheque.

## Fichiers du projet

- `index.js`: serveur web, authentification, sessions, moderation, menus, annonces, abonnements, statistiques, logs et orchestration WhatsApp.
- `og-screenshot.js`: generation de `public/og-image.png` via Puppeteer.
- `public/landing.html`: page publique marketing/SEO.
- `public/user-login.html`: page login/inscription/recuperation utilisateur.
- `public/admin-login.html`: page login admin.
- `public/admin.html`: gestion admin des utilisateurs.
- `public/index.html`: tableau de bord principal.
- `Dockerfile`, `docker-compose.yml`, `entrypoint.sh`: deploiement Docker.
- `data/`: stockage applicatif persistant.
- `.baileys_auth/`: stockage des identifiants Baileys.

## Stockage et etats persistants

- `data/beta_mode.json`: activation du mode beta.
- `data/users_auth.json`: utilisateurs applicatifs.
- `data/admin_auth.json`: compte admin principal.
- `data/user_sessions.json`: tokens de session web.
- `data/suggestions.json`: retours/commentaires utilisateurs.
- `data/announcements.json`: annonces creees, publiees et dupliquees.
- `data/subscription_settings.json`: configuration abonnement/paiement.
- `data/subscriptions.json`: abonnements par utilisateur.
- `data/sessions.json`: sessions WhatsApp multi-utilisateurs, session active, statut, QR, numero, proprietaire.
- `data/sessions/<sessionId>/config.json`: configuration de moderation par session.
- `data/sessions/<sessionId>/stats.json`: compteurs par session.
- `data/sessions/<sessionId>/warnings.json`: avertissements par groupe/utilisateur.
- `data/sessions/<sessionId>/groups.json`: exceptions de groupes et bienvenue.
- `data/sessions/<sessionId>/users.json`: exceptions utilisateurs/admins.
- `data/sessions/<sessionId>/logs.json`: journaux par session.
- `data/sessions/<sessionId>/processed.json`: messages deja traites.
- `data/sessions/<sessionId>/call_spam.json`: historique anti-spam appels.
- `data/sessions/<sessionId>/blocked_users.json`: blocages temporaires.
- `data/sessions/<sessionId>/call_history.json`: historique des appels rejetes.
- `data/sessions/<sessionId>/menus.json`: menus textuels.
- `data/sessions/<sessionId>/menu_sessions.json`: sessions de menu en attente.
- Fichiers globaux historiques pour la session par defaut: `warnings.json`, `config.json`, `logs.json`, `groups.json`, `users.json`, `processed.json`, `call_spam.json`, `blocked_users.json`, `menus.json`, `menu_sessions.json`.

## Fonctionnalites internes principales

- Mode beta: chargement, sauvegarde, exposition publique et activation admin.
- Comportement humain: delais gaussiens, lecture, reflexion, frappe, suppression, pauses inter-actions, pauses inter-groupes, ralentissement nocturne, distractions aleatoires.
- Rate limit global: 8 actions/minute, 120 actions/heure, attente automatique avant action.
- Envoi humanise: typing indicator, delai de lecture, delai de frappe, envoi texte/media, journalisation des erreurs.
- Suppression de message: Baileys natif `sock.sendMessage(chatId, { delete: message.key })`.
- Configuration de moderation: seuil d'avertissements, expiration, limite de scan, intervalle auto-scan, delais, bienvenue, appels, statut mention.
- Gestion d'abonnement: activation, expiration, rappels, avertissements, deconnexion de sessions non renouvelees.
- Gestion des annonces: creation, modification, suppression, duplication, stats, publication multi-groupes, image, HD best effort, apercu de lien.
- Formatage WhatsApp: conservation des marqueurs gras, italique, barre, monospace.
- Suggestions: ajout par utilisateur, liste admin, suppression admin.
- Authentification: admin bootstrap, inscription utilisateur, login, logout, tokens cookies, verification, changement de mot de passe, question de securite, reset, droits admin.
- Donnees par session: configuration, stats, avertissements, exceptions, logs, messages traites, appels, blocages, menus.
- Detection de liens: URL HTTP/HTTPS, `www`, `wa.me`, `chat.whatsapp.com`, domaines avec TLD valide, reduction des faux positifs, emails et domaines whitelistes selon contexte.
- Multi-sessions: creation, demarrage, arret, suppression, session active, sessions par proprietaire, nettoyage orphelin, QR timeout, initialisation au demarrage.
- Scan manuel/auto: scan groupe courant, scan tous groupes admin, delais humanises, suppression, avertissement, bannissement.
- Presence: alternance disponible/indisponible, mode nuit et pauses.
- Menus: menus textuels numerotes, listes, images, reponse par numero, reponse par texte approxime, sous-menus, message, lien, contact, webhook externe.
- Bienvenue: message configurable, variante pour groupes exclus, mention du nouveau membre, tentative avec photo de profil.
- Appels: rejet automatique, exemptions, compteur de spam, message post-appel, blocage WhatsApp temporaire, deblocage automatique, historique.
- Logs/stats: retention 24h, nettoyage, stats groupes, suppressions, avertissements, bannissements, appels, activite.
- OG image: capture Puppeteer du landing, regeneration admin, statut public.

## Integration Baileys native

`index.js` utilise directement Baileys:

- `makeWASocket` pour creer chaque session WhatsApp.
- `useMultiFileAuthState` pour stocker les credentials dans `.baileys_auth/<sessionId>`.
- `connection.update` pour QR, connexion, deconnexion, reconnexion et expiration QR.
- `messages.upsert` pour le traitement natif des messages entrants.
- `messaging-history.set` et `fetchMessageHistory` pour alimenter le scan historique natif.
- `group-participants.update` pour les messages de bienvenue.
- `call` pour le rejet d'appels et l'anti-spam.
- `sock.sendMessage` pour texte, medias, reactions, suppressions et reponses citees.
- `sock.groupParticipantsUpdate` pour bannir un membre.
- `sock.groupLeave` et `sock.chatModify` pour quitter/nettoyer localement un groupe.
- `sock.updateBlockStatus` pour bloquer/debloquer les spammeurs d'appels.
- `sock.profilePictureUrl` et `fetch` natif pour envoyer une bienvenue avec photo de profil.
- Caches internes natifs: chats, contacts, historique recent par groupe, blocklist.
- Normalisation JID: conversion `@c.us` vers `@s.whatsapp.net`, support groupes `@g.us`, conservation LID/phoneNumber.

## Evenements WhatsApp traites

- `qr`: stocke le QR dans la session, statut `qr`, affiche le QR terminal, supprime la session si non scanne apres 5 minutes.
- `ready`: statut `connected`, numero/pushName, activation session, timers de scan, presence et processus session.
- `auth_failure`: statut `auth_failure`, log.
- `disconnected`: statut `disconnected`, tentative de reconnexion si ce n'est pas `LOGOUT`.
- `message`: traitement menus, commandes admin, status mentions, moderation anti-liens.
- `group_join`: bienvenue si activee et bot admin.
- `call`: rejet, anti-spam, blocage/deblocage.

## Commandes WhatsApp admin

- `!scan`: scanne le groupe courant si l'expediteur est admin.
- `!scanall`: scanne tous les groupes ou le bot est admin.
- `!diagdelete`: envoie un diagnostic Baileys de suppression.
- `!testdelete`: envoie un message test puis tente de le supprimer.

## Endpoints pages

- `GET /`: landing public avec canonical/Open Graph dynamiques.
- `GET /auth`: login/inscription utilisateur.
- `GET /admin/login`: login admin.
- `GET /admin`: interface admin.
- `GET /dashboard`: tableau de bord principal.
- `GET /og-image.png`: image Open Graph generee.

## Endpoints authentification

- `GET /api/auth/setup-status`: indique si l'admin existe.
- `POST /api/auth/register`: cree un utilisateur et connecte automatiquement.
- `POST /api/auth/login`: connecte un utilisateur non-admin.
- `POST /api/auth/admin/login`: connecte l'admin.
- `POST /api/auth/logout`: supprime le token courant.
- `GET /api/auth/verify`: valide le token et renvoie l'identite.
- `POST /api/auth/recovery/question`: recupere la question de securite.
- `POST /api/auth/recovery/verify`: valide la reponse de securite.
- `POST /api/auth/recovery/reset`: change le mot de passe apres verification.
- `GET /api/auth/users`: liste admin des utilisateurs.
- `GET /api/auth/users/:username`: detail utilisateur + sessions.
- `POST /api/auth/users`: creation admin d'un utilisateur.
- `DELETE /api/auth/users/:username`: suppression admin d'un utilisateur et de ses sessions.
- `PUT /api/auth/admin/password`: changement du mot de passe admin.
- `PUT /api/auth/users/:username/password`: changement mot de passe utilisateur.
- `PUT /api/auth/users/:username/admin`: attribution/retrait des droits admin.

## Endpoints beta, suggestions, abonnements

- `GET /api/beta-status`: statut beta public.
- `POST /api/admin/beta-mode`: active/desactive beta, admin requis.
- `POST /api/suggestions`: ajoute une suggestion utilisateur.
- `GET /api/suggestions`: liste admin.
- `DELETE /api/suggestions/:id`: supprime une suggestion.
- `POST /api/subscription/create-checkout`: cree un checkout LeekPay si configure.
- `GET /api/subscription/settings`: expose les parametres publics d'abonnement.
- `GET /api/subscription/status`: statut abonnement de l'utilisateur.
- `POST /api/subscription/confirm`: confirme un paiement et active l'abonnement.
- `GET /api/admin/subscription/settings`: lit les parametres admin.
- `POST /api/admin/subscription/settings`: met a jour API keys, montant, duree, essai, site URL.
- `POST /api/admin/subscription/notify`: force les notifications/verifications abonnement.
- `GET /api/admin/subscriptions`: liste tous les abonnements.
- `POST /api/admin/subscriptions/:username`: accorde un abonnement manuel.
- `DELETE /api/admin/subscriptions/:username`: revoque un abonnement.

## Endpoints sessions WhatsApp

- `GET /api/sessions`: liste les sessions visibles par l'utilisateur.
- `POST /api/sessions`: cree une session WhatsApp.
- `GET /api/sessions/:id`: detail et QR d'une session.
- `POST /api/sessions/:id/activate`: definit la session active.
- `POST /api/sessions/:id/start`: demarre une session.
- `POST /api/sessions/:id/stop`: arrete une session.
- `DELETE /api/sessions/:id`: supprime session, auth et donnees.
- `GET /api/status`: statut client actif, QR, connexion, session.

## Endpoints configuration, stats, logs

- `GET /api/config`: lit la configuration de session.
- `POST /api/config`: met a jour moderation, scans, appels, bienvenue.
- `GET /api/stats`: stats globales ou session.
- `GET /api/logs`: logs visibles, agreges admin ou par session utilisateur.
- `POST /api/logs/clear`: vide les logs, admin requis.
- `GET /api/stats/groups`: groupes administres.
- `GET /api/stats/deleted`: total suppressions.
- `GET /api/stats/warnings`: total avertissements.
- `GET /api/stats/banned`: total bannissements.
- `GET /api/stats/calls`: total appels rejetes.
- `GET /api/calls/history`: historique appels.
- `GET /api/stats/activity`: activite recente calculee depuis logs.

## Endpoints moderation groupes/utilisateurs

- `POST /api/scan`: lance un scan global.
- `DELETE /api/warnings`: efface les avertissements.
- `GET /api/groups`: groupes ou le bot est admin.
- `GET /api/groups/all`: tous les groupes ou le bot est present.
- `POST /api/groups/leave`: quitte un groupe.
- `DELETE /api/groups/delete`: quitte/supprime un groupe si bot admin.
- `GET /api/groups/exceptions`: lit exclusions de groupes/motifs/bienvenue.
- `POST /api/groups/exceptions`: ajoute exclusion groupe ou motif.
- `DELETE /api/groups/exceptions`: retire exclusion groupe ou motif.
- `POST /api/groups/welcome`: active/desactive bienvenue par groupe.
- `GET /api/users/exceptions`: lit whitelist utilisateurs et exclusion admins.
- `POST /api/users/exceptions`: ajoute/met a jour exceptions lien/appel.
- `DELETE /api/users/exceptions`: supprime exception utilisateur.
- `POST /api/users/exceptions/admins`: active/desactive exemption admins.
- `GET /api/blocked`: liste les utilisateurs bloques temporairement.
- `POST /api/blocked/unblock`: debloque un utilisateur.
- `GET /api/ratelimit`: expose l'etat du rate limiter.

## Endpoints menus

- `GET /api/menus`: liste les menus.
- `GET /api/menus/:id`: lit un menu.
- `POST /api/menus`: cree un menu.
- `PUT /api/menus/:id`: met a jour un menu.
- `DELETE /api/menus/:id`: supprime un menu.
- `POST /api/menus/:id/test`: envoie un menu dans un groupe cible ou le premier groupe admin.

## Endpoints annonces et previews

- `GET /api/announcements`: liste les annonces accessibles.
- `GET /api/announcements/groups`: groupes admin disponibles pour publication.
- `GET /api/announcements/stats`: stats annonces.
- `GET /api/announcements/:id`: detail annonce avec controle proprietaire/admin.
- `POST /api/announcements`: cree une annonce.
- `PUT /api/announcements/:id`: modifie une annonce.
- `DELETE /api/announcements/:id`: supprime une annonce.
- `POST /api/announcements/:id/publish`: publie une annonce.
- `POST /api/announcements/:id/duplicate`: duplique une annonce.
- `GET /api/link-preview`: recupere titre, description, image et site d'une URL.
- `POST /api/admin/og-image/refresh`: regenere l'image OG.
- `GET /api/og-image/status`: statut/fraicheur de l'image OG.

## Actions UI principales

- Auth utilisateur: changer onglet login/inscription, inscription, login, question de securite, verification, reset mot de passe, theme clair/sombre.
- Auth admin: login admin, affichage obligation de changer le mot de passe.
- Dashboard: navigation pages, theme, toasts, lecture config, sauvegarde config, statut bot, QR, logs, stats.
- Sessions: liste, creation, activation, affichage QR, demarrage, arret/redemarrage, suppression.
- Groupes: chargement groupes admin/tous groupes, quitter, supprimer, exclusions groupe/motif, bienvenue par groupe.
- Utilisateurs: liste exceptions, ajout, suppression, cases exception lien/appel, exemption admins.
- Menus: liste, editeur modal, ajout/retrait boutons, sections, lignes, image, test, sauvegarde, suppression.
- Annonces: liste, creation, edition, duplication, suppression, publication, selection groupes, image, HD, preview lien.
- Suggestions: modal suggestion, envoi suggestion, gestion admin.
- Abonnements: statut, checkout, confirmation retour/cancel, settings admin, attribution/revocation admin.
- Admin users: liste, creation, modification droits, changement mot de passe, suppression.

## Points de migration Baileys appliques

- Installation `baileys@^7.0.0-rc13`.
- Suppression de l'ancienne dependance WhatsApp.
- Auth de `.wwebjs_auth/` vers `.baileys_auth/`.
- Docker passe a Node 22.
- `docker-compose.yml` monte `.baileys_auth`.
- `entrypoint.sh` prepare `.baileys_auth`.
- Landing/README indiquent Baileys.
- Le bot genere un QR Baileys au demarrage des sessions existantes; un rescannage est requis.
