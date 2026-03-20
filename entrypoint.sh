#!/bin/sh

# Créer les fichiers JSON s'ils n'existent pas ou sont des répertoires
for file in config.json warnings.json blocked_users.json logs.json groups.json call_spam.json; do
    if [ ! -f "/app/$file" ]; then
        rm -rf "/app/$file"  # Supprimer si c'est un répertoire
        echo '{}' > "/app/$file"
    fi
done

# Créer les répertoires nécessaires
mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache

# Lancer l'application
exec npm start
