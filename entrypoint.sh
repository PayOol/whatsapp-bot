#!/bin/sh

# Nettoyer les fichiers de verrouillage Chromium pour permettre le redémarrage
rm -rf /app/.wwebjs_auth/SingletonLock 2>/dev/null
rm -rf /app/.wwebjs_auth/SingletonCookie 2>/dev/null
rm -rf /app/.wwebjs_auth/SingletonSocket 2>/dev/null
rm -rf /app/.wwebjs_auth/Default/SingletonLock 2>/dev/null
rm -rf /app/.wwebjs_auth/Default/SingletonCookie 2>/dev/null
rm -rf /app/.wwebjs_auth/Default/SingletonSocket 2>/dev/null

# Créer les fichiers JSON s'ils n'existent pas ou sont des répertoires
# logs.json et warnings.json doivent être des tableaux
for file in config.json blocked_users.json groups.json call_spam.json; do
    if [ ! -f "/app/$file" ]; then
        rm -rf "/app/$file"  # Supprimer si c'est un répertoire
        echo '{}' > "/app/$file"
    fi
done

# Fichiers qui doivent être des tableaux
for file in logs.json warnings.json; do
    if [ ! -f "/app/$file" ]; then
        rm -rf "/app/$file"  # Supprimer si c'est un répertoire
        echo '[]' > "/app/$file"
    fi
done

# Créer les répertoires nécessaires
mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache

# Lancer l'application
exec npm start
