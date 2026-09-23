# ORSYNE — image de production
# Une seule dependance (pg), aucune etape de build : l'image est petite
# et ce qui tourne est exactement ce qui est versionne.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Les dependances d'abord : couche mise en cache tant que le lockfile ne change pas.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY db ./db
COPY src ./src
COPY public ./public

# Jamais root dans le conteneur.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

# main.js : controle de configuration, migrations, puis service.
CMD ["node", "src/main.js"]
