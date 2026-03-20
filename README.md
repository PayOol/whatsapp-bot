# WhatsApp Link Guard Bot

Bot WhatsApp qui supprime automatiquement les liens dans les groupes et gère les avertissements.

## Fonctionnalités

- 🔍 Détection automatique des liens (HTTP, HTTPS, WhatsApp, etc.)
- 🗑️ Suppression automatique des messages contenant des liens
- ⚠️ Système d'avertissements avec compteur
- 🚫 Bannissement automatique après le seuil d'avertissements
- 💾 Stockage persistant des avertissements
- ⏰ Expiration des avertissements après 24h
- 👑 Les administrateurs peuvent partager des liens

## Prérequis

- Node.js v16 ou supérieur
- Un compte WhatsApp
- Google Chrome ou Chromium installé

## Installation

1. **Installer les dépendances :**
   ```bash
   npm install
   ```

2. **Configurer le bot (optionnel) :**
   
   Modifiez les constantes dans `index.js` :
   ```javascript
   const CONFIG = {
       MAX_WARNINGS: 3,           // Nombre max d'avertissements
       WARNING_EXPIRY_HOURS: 24,  // Expiration des avertissements
   };
   ```

## Utilisation

1. **Démarrer le bot :**
   ```bash
   npm start
   ```

2. **Scanner le QR code :**
   
   Un QR code apparaîtra dans le terminal. Scannez-le avec votre application WhatsApp :
   - Ouvrez WhatsApp
   - Paramètres > Appareils liés
   - Scanner le QR code

3. **Ajouter le bot à un groupe :**
   
   Ajoutez le numéro WhatsApp associé au bot à vos groupes et **assurez-vous qu'il est administrateur**.

## Fonctionnement

1. Le bot surveille tous les messages dans les groupes où il est admin
2. Quand un lien est détecté, le message est supprimé
3. L'utilisateur reçoit un avertissement avec le compteur
4. Après `MAX_WARNINGS` avertissements, l'utilisateur est banni
5. Les avertissements expirent après 24 heures

## Structure des fichiers

```
WhatsApp Bot/
├── index.js          # Code principal du bot
├── package.json      # Dépendances npm
├── warnings.json     # Stockage des avertissements (créé automatiquement)
├── .wwebjs_auth/     # Session WhatsApp (créé automatiquement)
└── README.md         # Documentation
```

## Notes importantes

- Le bot doit être **administrateur** du groupe pour supprimer des messages et bannir
- Les administrateurs du groupe peuvent partager des liens sans restriction
- La première connexion nécessite de scanner le QR code
- Les connexions suivantes utiliseront la session sauvegardée

## Dépannage

**Le bot ne supprime pas les messages :**
- Vérifiez qu'il est admin dans le groupe
- Vérifiez que le message contient bien un lien reconnu

**Erreur "Failed to launch the browser" :**
- Installez Google Chrome ou Chromium
- Sur Linux, vous pouvez avoir besoin de dépendances supplémentaires

**Session perdue :**
- Supprimez le dossier `.wwebjs_auth`
- Relancez le bot et scannez le QR code
