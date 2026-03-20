#!/bin/sh

# Nettoyer les fichiers de verrouillage Chromium récursivement avec find
echo "🔧 Nettoyage des fichiers de verrouillage Chromium..."
find /app/.wwebjs_auth -name "Singleton*" -exec rm -f {} \; 2>/dev/null
echo "   ✅ Nettoyage terminé"

# Créer le dossier data s'il n'existe pas
mkdir -p /app/data

# Créer les fichiers JSON s'ils n'existent pas ou sont des répertoires
# logs.json et warnings.json doivent être des tableaux
for file in config.json blocked_users.json groups.json call_spam.json; do
    if [ ! -f "/app/data/$file" ]; then
        rm -rf "/app/data/$file"  # Supprimer si c'est un répertoire
        echo '{}' > "/app/data/$file"
    fi
done

# Fichiers qui doivent être des tableaux
for file in logs.json warnings.json; do
    if [ ! -f "/app/data/$file" ]; then
        rm -rf "/app/data/$file"  # Supprimer si c'est un répertoire
        echo '[]' > "/app/data/$file"
    fi
done

# Créer les répertoires nécessaires
mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache

# Lancer l'application
exec npm start
