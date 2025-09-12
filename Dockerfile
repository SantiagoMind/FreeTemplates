FROM node:22-slim

# Dependencias de Chromium headless y fuentes
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
    libxshmfence1 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
    libgtk-3-0 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libpango-1.0-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Directorios de runtime
RUN mkdir -p assets tmp
ENV TMPDIR=/app/tmp

# Instala dependencias (incluye Chromium de Puppeteer)
COPY package*.json ./
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
RUN npm install --omit=dev

# Fuerza rebuild si el cache de Render es agresivo
ARG CACHE_BUST=20250912
ENV CACHE_BUST=${CACHE_BUST}

# Código
COPY . .

# Puerto del servidor (index.mjs usa PORT o 10000)
EXPOSE 10000

CMD ["npm","start"]