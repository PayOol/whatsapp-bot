#!/bin/sh

# Nettoyer tous les fichiers de verrouillage Chromium (session et sous-dossiers)
rm -f /app/.wwebjs_auth/Singleton* 2>/dev/null
rm -f /app/.wwebjs_auth/*/Singleton* 2>/dev/null
rm -f /app/.wwebjs_auth/*/*/Singleton* 2>/dev/null

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
