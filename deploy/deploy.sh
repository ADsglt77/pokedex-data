#!/bin/sh
# Le déploiement sur le VPS, une fois le code à jour (`git pull --ff-only`), lancé par le workflow
# `.github/workflows/deploy.yml` : reconstruit et redémarre les conteneurs, puis vérifie que l'API
# répond.
set -e
cd "$(dirname "$0")/.."

# `--pull` : l'image de base (bun) reçoit ses correctifs ; `--remove-orphans` : un service retiré de
# compose.yaml est arrêté.
docker compose build --pull
docker compose up -d --remove-orphans

# L'API répond-elle ? Aucun port publié : demandé depuis son conteneur. `/v1/health` rend 503 quand
# une tâche est en retard, une affaire de données, pas de déploiement : seule une absence de réponse
# fait échouer le déploiement, en rouge.
ok=
for attempt in $(seq 1 30); do
  if docker compose exec -T api bun -e "fetch('http://127.0.0.1:3001/v1/health').then(() => process.exit(0), () => process.exit(1))"; then
    ok=1
    break
  fi
  sleep 2
done
if [ -z "$ok" ]; then
  echo "L'API ne répond pas après le déploiement (voir docker compose logs api)."
  docker compose ps
  exit 1
fi

# Les images d'avant restent une semaine : un retour arrière se reconstruit vite.
docker image prune -f --filter until=168h
