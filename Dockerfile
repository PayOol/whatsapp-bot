FROM node:18-slim

# Installer les dépendances pour Chromium/Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Définir le chemin vers Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances
RUN npm install

# Copier le code source
COPY . .

# Créer les répertoires pour la persistance
RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache

# Exposer le port pour Express (si utilisé)
EXPOSE 3000

CMD ["npm", "start"]
