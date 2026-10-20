# Pokédex · données

L'API privée des données du Pokédex de cartes Pokémon japonaises : les espèces (PokéAPI), le
catalogue des cartes japonaises et leurs images (Pokécardex), les prix Cardmarket du jour et leur
historique. Elle les relit à son rythme, les range dans une base SQLite et les rend au site, et
à lui seul : sans token, aucune donnée. Bun, Elysia, SQLite.

```sh
bun install
bun run dev            # l'API, sur http://127.0.0.1:3001 (relancée à chaque modification)
bun run ingest <tâche> # une tâche d'ingestion, tout de suite (plus bas)
bun run ingest cards   # les nouvelles cartes : catalogue, puis leurs images et leur historique
bun test               # tests (prix, historique, liste de souhaits, schéma, accès)
bun run typecheck      # TypeScript
bun run lint           # ESLint, puis knip (code mort)
bun run format         # Prettier
```

## L'API

Chaque requête porte un token : `Authorization: Bearer <token>`. Sans lui, ou avec un autre :
401, sans corps (une adresse inconnue aussi : rien ne dit ce qui existe). Les tokens des clients
sont dans `API_TOKENS` (le `.env`), un par client : `nom:token,…` ; aujourd'hui un seul,
`pokedex`, le site. Un token se tire au hasard : `openssl rand -hex 32`.

| Route | Réponse |
|---|---|
| `GET /v1/species`, `/v1/species/details` | Les 1 025 espèces ; ce qu'en montre leur fiche |
| `GET /v1/catalog/species/:id` | Les cartes japonaises d'un Pokémon |
| `GET /v1/catalog/sets`, `/v1/catalog/sets/:code` | Les séries ; toutes les cartes d'une série |
| `GET /v1/prices?ids=…` | Les prix du jour des cartes demandées (ids Cardmarket) |
| `GET /v1/prices/:id`, `/v1/histories?ids=…` | L'historique d'une carte ; de plusieurs |
| `GET /v1/wants?ids=…` | La ligne de chaque carte pour la liste de souhaits Cardmarket |
| `GET /v1/status` | Chaque tâche : son identifiant, son libellé et son état |
| `GET /v1/images/…` | Une image copiée (copiée à la demande si elle manque) |
| `GET /v1/health` | **Sans token** : 200, ou 503 si une tâche à rythme est en retard |

La forme de chaque réponse : `src/contract.ts`, dont le site garde une copie. Les grosses
réponses portent un ETag (304 tant qu'elles n'ont pas changé) et arrivent compressées (gzip). En développement, la documentation (OpenAPI) est à `http://127.0.0.1:3001/docs`.

Les chemins des images ne nomment aucune source : `/v1/images/cards/<série>/<n>-<md|hd>.webp`,
`/v1/images/sets/<série>-<md|hd>.webp`, `/v1/images/types/<n>.webp`,
`/v1/images/rarities/<n>.webp`, `/v1/images/species/<n>.png`. Seule l'API connaît leur adresse
d'origine.

## Les tâches d'ingestion

| Tâche | Rythme | Ce qu'elle fait |
|---|---|---|
| `species` | chaque mois | Les espèces, d'après PokéAPI |
| `catalog` | à la demande | Le catalogue des cartes japonaises, d'après Pokécardex (une page par série, toutes les 3 s : une vingtaine de minutes la première fois ; `--refresh` relit toutes les séries) |
| `images` | à la demande | Les images qui manquent : logos, icônes, Pokémon, scans des cartes (environ 1,5 Go la première fois) |
| `prices` | toutes les 6 h | Le guide des prix public de Cardmarket, et l'historique du jour |
| `history` | à la demande | Les 180 derniers jours de prix de chaque carte, une fois par carte, d'après Pokécardex (environ 23 h la première fois) |
| `backups` | chaque jour | Une copie de la base (7 gardées) |

Quand de nouvelles cartes sortent : `bun run ingest cards` enchaîne le catalogue, puis les images
et l'historique (seulement ce qui manque : les nouvelles cartes). Chaque tâche reste lançable
seule. Après un échec, une tâche à rythme repasse 10 min plus tard, puis 20, 40… jusqu'à 6 h.
Arrêtée (Ctrl+C), une tâche est notée interrompue ; relancée, elle reprend où elle en était.

## En développement

Un fichier `.env` (ignoré par git), sur le modèle de `.env.example` :

```sh
echo "API_TOKENS=pokedex:$(openssl rand -hex 32)" > .env
```

Le même token va dans le `.env` du site (`DATA_API_TOKEN`). La base vit dans `.data/` ; la
remplir une fois : `bun run ingest species`, `bun run ingest prices`, puis `bun run ingest cards`
(l'historique prend environ 23 h : il s'arrête et reprend à volonté). Les images n'ont pas besoin
d'être toutes copiées : l'API copie à la demande celles qu'on lui demande.

**Le journal** : une ligne par évènement, alignée, à l'heure de Paris (pas les requêtes une à
une) : un token refusé (une ligne par minute au plus, jamais le token), une image que sa source
n'a pas donnée, une erreur de l'API. Sans couleurs avec `NO_COLOR=1`.

## Déploiement (le VPS du site)

L'API tourne sur le même VPS que le site, dans ses propres conteneurs, **sans aucun port
publié** : le site la joint par un réseau Docker commun, `pokedex-net`, à l'adresse
`http://data-api:3001`. À installer avant le site.

**Une fois, sur le VPS**

1. Le réseau commun aux deux :
   ```sh
   docker network create pokedex-net
   ```
2. Cloner le dépôt **en SSH**, avec une clé de déploiement en lecture seule (le dépôt est privé) :
   ```sh
   git clone git@github.com:ADsglt77/pokedex-data.git
   cd pokedex-data
   ```
3. Le fichier `.env` (ignoré par git ; sans lui, docker compose refuse de démarrer), avec le token
   du site, à reporter dans le `.env` du site (`DATA_API_TOKEN`) :
   ```sh
   echo "API_TOKENS=pokedex:$(openssl rand -hex 32)" > .env
   chmod 600 .env
   docker compose up -d --build
   ```
4. Remplir la base : les espèces et les prix passent seuls au démarrage du service `ingest` ; les
   cartes, une fois (le catalogue, les images, puis l'historique : un jour environ) :
   ```sh
   docker compose run --rm ingest bun src/ingest.ts cards
   ```
   Pour la lancer sans garder le terminal ouvert : `docker compose run -d --name cartes ingest bun
   src/ingest.ts cards`, puis `docker logs -f cartes`.

**Ensuite, à chaque déploiement** (`.github/workflows/deploy.yml`, lancé à la main depuis l'onglet
Actions) : GitHub se connecte au VPS en SSH, fait `git pull` et lance `deploy/deploy.sh`. La
construction lance d'abord les tests, TypeScript, ESLint et knip ; si elle échoue, l'ancienne
version reste en ligne. Une fois les conteneurs redémarrés, le script vérifie que l'API répond. Les
secrets du dépôt : les mêmes que ceux du site (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PORT`,
`VPS_FINGERPRINT`), et `VPS_PATH`, le dossier de ce clone.

**Lancer une tâche à la main** (de nouvelles cartes, relire tout le catalogue…) :

```sh
docker compose run --rm ingest bun src/ingest.ts cards
docker compose run --rm ingest bun src/ingest.ts catalog --refresh
```

Une tâche déjà en cours ailleurs n'est pas doublée. **La surveillance** : `/v1/health` (par le
site : `https://votre-domaine/api/health`) répond 200 quand chaque tâche à rythme a réussi
récemment (deux intervalles au plus : les prix en 12 h, les sauvegardes en 2 jours, les espèces en
60 jours) et que le guide des prix n'est pas figé, 503 sinon, avec les tâches en retard. Un trou
dans l'historique des prix ne se rattrape jamais (Cardmarket n'en garde pas).

Ne jamais lancer `docker compose down -v`, qui effacerait les volumes (`data` : la base et
l'historique des prix ; `backups` ; `images`).

## Sauvegardes

Chaque jour, le service `ingest` copie la base dans le volume `backups` : `data-AAAA-MM-JJ.db.gz`
(7 gardées), vérifiée (`PRAGMA quick_check`) et écrite sous un nom provisoire avant de prendre sa
place. Ce volume est sur le même disque que la base : copiez-le aussi ailleurs, par exemple
chaque nuit avec `rclone` (dans la crontab de l'utilisateur du déploiement, le dossier du clone à
adapter) :

```sh
45 4 * * * cd /home/moi/pokedex-data && rm -rf sauvegardes && mkdir sauvegardes && docker compose run --rm --no-deps --user root -v "$PWD/sauvegardes:/out" ingest sh -c 'cp /backups/data-* /out/' && rclone copy sauvegardes distant:pokedex-data-sauvegardes && rclone delete --min-age 90d distant:pokedex-data-sauvegardes
```

**Restaurer une sauvegarde** : arrêter l'API et les tâches, remettre la copie à la place de la
base, sans les fichiers `-wal` et `-shm` de l'ancienne, puis redémarrer :

```sh
docker compose stop api ingest
docker compose run --rm --no-deps --user root -v "$PWD/sauvegardes:/restore:ro" api sh -c 'rm -f /data/data.db-wal /data/data.db-shm && gunzip -c /restore/data-AAAA-MM-JJ.db.gz > /data/data.db && chown bun:bun /data/data.db'
docker compose up -d
```
