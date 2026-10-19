# Bun figé sur sa version mineure : `build --pull` prend ses correctifs, jamais une nouvelle version
# de `bun:sqlite`, de `Bun.serve` ou du format de `bun.lock` sans prévenir.

# 1. Tests, types, lint et code mort (ESLint, knip) : un échec arrête la construction, et l'ancien
#    conteneur reste en ligne.
FROM oven/bun:1.3-alpine AS check
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun test && bun run typecheck && bun run lint

# 2. L'API et les tâches d'ingestion (services `api` et `ingest`) : Bun lance le code tel quel ;
#    `tsconfig.json` lui donne l'alias `@/` vers `src/`. La base vit dans le volume `data`
#    (`DATA_DIR`), les images dans `images`, les sauvegardes dans `backups`. Son `package.json`
#    vient de l'étape 1 : elle passe donc d'abord, et un test en échec arrête aussi cette image (un
#    `docker compose run ingest` ne lancerait pas du code non testé).
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=check /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src src
# `production` : des tokens de 32 caractères au moins. `HOST` : l'API écoute toutes les adresses de
# son conteneur, pour le site (hors Docker, la machine seulement).
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data IMAGES_DIR=/images BACKUP_DIR=/backups
# Sans droits d'administrateur (l'utilisateur `bun` de l'image) : une faille de l'API ne donnerait
# pas la main sur le conteneur. Les points de montage lui appartiennent, et un volume neuf en hérite.
RUN mkdir -p /data /images /backups && chown bun:bun /data /images /backups
USER bun
CMD ["bun", "src/index.ts"]
