#!/bin/sh
# Le déploiement sur le VPS, une fois le code à jour (`git pull --ff-only`), lancé par le workflow
# `.github/workflows/deploy.yml` : reconstruit et redémarre les conteneurs, puis vérifie que l'API
# répond.
set -e
cd "$(dirname "$0")/.."

# `--pull` : l'image de base (bun) reçoit ses correctifs ; `--remove-orphans` : un service retiré de
# compose.yaml est arrêté. `--wait` : attend, 2 min au plus, que l'API soit saine (son healthcheck,
# compose.yaml : elle répond, même 503 quand une tâche est en retard, une affaire de données, pas de
# déploiement) et qu'`ingest` tourne ; sinon le déploiement échoue, en rouge.
docker compose build --pull
if ! docker compose up -d --remove-orphans --wait --wait-timeout 120; then
  echo "L'API ne répond pas après le déploiement (voir docker compose logs api)."
  docker compose ps
  exit 1
fi

# Les images d'avant restent une semaine : un retour arrière se reconstruit vite. Le cache de
# construction aussi (l'étape des tests en laisse un à chaque déploiement) : au-delà, il remplirait
# le disque, celui de la base et des images.
docker image prune -f --filter until=168h
docker builder prune -f --filter until=168h
