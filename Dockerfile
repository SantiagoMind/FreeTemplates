FROM node:22-slim

# Fuentes y libs para Chrome headless
RUN apt-get update && apt-get install -y \
    fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
    libxshmfence1 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
    libgtk-3-0 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libpango-1.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

EXPOSE 8080
CMD ["npm","start"]