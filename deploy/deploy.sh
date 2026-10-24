#!/bin/sh
# Le déploiement sur le VPS, une fois le code à jour (`git pull --ff-only`), lancé par le workflow
# `.github/workflows/deploy.yml` : reconstruit et redémarre les conteneurs, vérifie que l'API
# répond, et signale le conteneur ponctuel des cartes s'il tourne encore avec le code d'avant.
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

# Le conteneur ponctuel des cartes (README : `docker compose run -d --name pokedex-data-cards …`)
# n'est pas recréé : il garde le code d'avant, qui continuerait d'écrire la base. Le déploiement ne
# l'arrête pas (son historique peut avoir des heures en cours) : il le signale.
if [ -n "$(docker ps -q --filter name=pokedex-data-cards)" ]; then
  echo "Attention : le conteneur pokedex-data-cards tourne encore, avec le code d'avant."
  echo "L'arrêter (docker stop pokedex-data-cards, puis docker rm pokedex-data-cards) et relancer"
  echo "sa tâche (README) : elle reprend où elle en était."
fi

# Les images d'avant et le cache de construction (l'étape des tests en laisse un à chaque
# déploiement) restent une semaine : au-delà, ils rempliraient le disque, celui de la base et des
# images. Un retour arrière du code se reconstruit donc vite, mais pas par-dessus une étape du
# schéma (`DATA_STEPS`, `src/db.ts`) : le code d'avant refuse une base passée à une étape qu'il ne
# connaît pas, il faut alors remettre une copie de la base d'avant l'étape (README, « Revenir en
# arrière »).
docker image prune -f --filter until=168h
docker builder prune -f --filter until=168h
