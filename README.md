# Pokédex · données

L'API privée des données du Pokédex de cartes Pokémon japonaises et françaises (PokéCodex, en ligne
à https://pokecodex.fr) : les espèces (PokéAPI), le catalogue des cartes japonaises et françaises et
leurs images (Pokécardex), les prix Cardmarket du jour et leur historique. Elle les relit à son
rythme, les range dans une base SQLite et les rend au site, et à lui seul : sans token, aucune
donnée. Bun, Elysia, SQLite.

```sh
bun install
bun run dev            # l'API, sur http://127.0.0.1:3001 (relancée à chaque modification)
bun run setup          # première installation complète, avec progression
bun run ingest <tâche> # une tâche d'ingestion, tout de suite (plus bas)
bun run ingest cards   # les nouvelles cartes : catalogue, puis leurs images et leur historique
bun test               # tests (prix, historique, liste de souhaits, schéma, accès, tâches)
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
| `GET /v1/catalog/fr/species/:id`, `/v1/catalog/fr/sets`, `/v1/catalog/fr/sets/:code` | Les mêmes, pour les cartes françaises (leur sortie : celle en France) |
| `GET /v1/prices?ids=…` | Les prix du jour des cartes demandées (ids Cardmarket) |
| `GET /v1/prices/:id`, `/v1/histories?ids=…` | L'historique d'une carte ; de plusieurs |
| `GET /v1/wants?ids=…` | La ligne de chaque carte pour la liste de souhaits Cardmarket |
| `GET /v1/status` | Chaque tâche : son identifiant, son libellé et son état |
| `GET /v1/images/…` | Une image copiée (404 tant que la tâche `images` ne l'a pas copiée : rien n'est copié à la demande) |
| `GET /v1/health` | **Sans token** : 200, ou 503 si une tâche à rythme est en retard ou les prix figés |

La forme de chaque réponse : `src/contract.ts`, dont le site garde une copie. Les grosses
réponses portent un ETag (304 tant qu'elles n'ont pas changé) et arrivent compressées (gzip). En développement, la documentation (OpenAPI) est à `http://127.0.0.1:3001/docs`.

Les chemins des images ne nomment aucune source : `/v1/images/cards/<série>/<n>-<md|hd>.webp`,
`/v1/images/sets/<série>-<md|hd>.webp` (celles des cartes japonaises ; les françaises, avec `fr/`
avant la série : `/v1/images/cards/fr/<série>/…`, `/v1/images/sets/fr/<série>-…`),
`/v1/images/types/<n>.webp`, `/v1/images/rarities/<n>.webp`, `/v1/images/species/<n>.png`. Seule
l'API connaît leur adresse d'origine.

## Les tâches d'ingestion

| Tâche | Rythme | Ce qu'elle fait |
|---|---|---|
| `species` | chaque mois | Les espèces, d'après PokéAPI |
| `catalog` | à la demande | Le catalogue des cartes japonaises, puis des françaises, d'après Pokécardex (une page par série, toutes les 3 s : environ 20 minutes la première fois pour les japonaises, 13 de plus pour les françaises, 250 séries ; `--refresh` relit toutes les séries) |
| `images` | à la demande | Les images qui manquent, toutes d'avance : logos, icônes, Pokémon, scans des cartes japonaises et françaises (environ 1,5 Go la première fois pour les japonaises, 1 à 1,4 Go de plus pour les françaises) |
| `prices` | toutes les 6 h | Le guide des prix public de Cardmarket, et l'historique du jour |
| `history` | à la demande | Les 180 derniers jours de prix de chaque carte, une fois par carte, d'après Pokécardex (environ 23 h la première fois pour les japonaises, 12 à 20 h de plus pour les françaises) |
| `backups` | chaque jour | Une copie de la base (7 gardées) |

Quand de nouvelles cartes sortent : `bun run ingest cards` enchaîne le catalogue, puis les images
et l'historique (seulement ce qui manque : les nouvelles cartes). Chaque tâche reste lançable
seule. Après un échec, une tâche à rythme repasse 10 min plus tard, puis 20, 40… jusqu'à 6 h.
Arrêtée (Ctrl+C, `docker compose stop`), une tâche est notée interrompue ; arrêtée net (conteneur
tué, VPS redémarré), elle l'est à sa relance suivante. Relancée, elle reprend où elle en était.

## En développement

Un fichier `.env` (ignoré par git), sur le modèle de `.env.example` :

```sh
echo "API_TOKENS=pokedex:$(openssl rand -hex 32)" > .env
```

Le même token va dans le `.env` du site (`DATA_API_TOKEN`). La base vit dans `.data/` ; la remplir
une fois avec `bun run setup`, qui enchaîne les espèces, le catalogue, les prix (après le
catalogue : le prix d'une carte d'une série récente en dépend), les images et l'historique avec une
progression visible (environ 40 h la première fois, cartes françaises comprises ; arrêté, il
reprend où il en était quand on le relance). Les images doivent toutes être copiées : l'API n'en
copie aucune elle-même, une image qui manque répond 404.

**Le journal** : une ligne par évènement, alignée, à l'heure de Paris (pas les requêtes une à
une) : un token refusé (une ligne par minute au plus, jamais le token), une erreur de l'API. Sans
couleurs avec `NO_COLOR=1`.

## Déploiement (le VPS du site)

L'API tourne sur le même VPS que le site, dans ses propres conteneurs, **sans aucun port
publié** : le site la joint par un réseau Docker commun, `pokedex-net`, à l'adresse
`http://data-api:3001` (le public passe par Caddy, puis le nginx du site, puis elle). Sur un
nouveau VPS, à installer avant le site.

**Une fois, sur le VPS**

1. Le réseau commun aux deux :
   ```sh
   docker network create pokedex-net
   ```
2. Cloner le dépôt **en SSH**, avec une clé de déploiement GitHub en lecture seule (le dépôt est
   privé). GitHub n'accepte une clé de déploiement que sur un seul dépôt : pas celle du clone du
   site, une autre, déclarée dans `~/.ssh/config` sous un autre nom de `github.com` :
   ```sh
   ssh-keygen -t ed25519 -N '' -C github-pokedex-data -f ~/.ssh/github-pokedex-data
   printf 'Host github-pokedex-data\n  HostName github.com\n  IdentityFile ~/.ssh/github-pokedex-data\n  IdentitiesOnly yes\n' >> ~/.ssh/config
   # ~/.ssh/github-pokedex-data.pub : dans Settings › Deploy keys du dépôt, en lecture seule
   git clone git@github-pokedex-data:ADsglt77/pokedex-data.git
   cd pokedex-data
   ```
3. Le fichier `.env` (ignoré par git ; sans lui, docker compose refuse de démarrer), avec le token
   du site, à reporter dans le `.env` du site (`DATA_API_TOKEN`) :
   ```sh
   echo "API_TOKENS=pokedex:$(openssl rand -hex 32)" > .env
   chmod 600 .env
   docker compose build --pull
   ```
4. Sur une base vide, le catalogue d'abord (une vingtaine de minutes) : le prix d'une carte d'une
   série récente en dépend, et un premier guide des prix lu sans lui resterait faux dans
   l'historique.
   ```sh
   docker compose run --rm ingest bun src/ingest.ts catalog
   ```
5. Puis, tout de suite, l'API et les tâches à rythme (le service `ingest` : les espèces, les prix
   toutes les 6 h, la sauvegarde chaque jour). Elles n'attendent pas les cartes : un guide des
   prix pas lu le jour même manque pour toujours à l'historique. Docker relance ces deux services
   après un arrêt ou un redémarrage du VPS (`restart: unless-stopped`).
   ```sh
   docker compose up -d
   ```
6. Le reste des cartes, japonaises et françaises (le catalogue français, environ 15 minutes ; leurs
   images, 2,5 à 3 Go en tout ; puis leur historique : environ 40 h en tout la première fois), dans
   un conteneur ponctuel, sans garder la connexion SSH ouverte :
   ```sh
   docker compose run -d --name pokedex-data-cards ingest bun src/ingest.ts cards
   docker logs -f pokedex-data-cards
   ```
   Ce conteneur-là, Docker ne le relance pas (un `docker compose run` n'a pas de politique de
   redémarrage) : après un redémarrage du VPS ou un arrêt brutal, relancer `cards` comme ci-dessous.
   Quand le journal indique la fin, lire son code de sortie et retirer le conteneur :
   ```sh
   docker inspect pokedex-data-cards --format '{{.State.ExitCode}}'
   docker rm pokedex-data-cards
   ```
   `0` : tout est là. `1` : une étape au moins a échoué (le journal dit laquelle ; une seule série,
   image ou carte en échec suffit). Relancer `cards`, qui ne refait que ce qui manque (les séries
   pas encore lues, les images absentes, l'historique des cartes pas encore lues), jusqu'à `0` :
   ```sh
   docker compose run -d --name pokedex-data-cards ingest bun src/ingest.ts cards
   ```

**Les cartes françaises, sur un VPS déjà en place** (une seule fois) : déployer l'API des données
d'abord (ses routes japonaises ne changent pas : le site d'avant continue de tourner), puis le
site. Au démarrage, l'API passe une étape de schéma qui ajoute la langue aux clés du catalogue
(les cartes japonaises deviennent `ja`, rien ne se perd ; la sauvegarde du jour suffit si l'on
veut une copie d'avant). Le catalogue français n'est pas encore lu : ses routes (`/v1/catalog/fr/…`)
répondent 404 tant que `catalog` n'a pas tourné, et le site le dit. Le premier remplissage
français, dans un conteneur ponctuel (comme à l'étape 6) :

```sh
docker compose run -d --name pokedex-data-cards ingest bun src/ingest.ts cards
docker logs -f pokedex-data-cards
```

Il enchaîne le catalogue (environ 15 minutes, 250 séries et 25 600 cartes), leurs images (1 à
1,4 Go de plus dans le volume `images`) puis leur historique (12 à 20 heures) ; ce que les
japonaises ont déjà n'est pas refait, et chaque étape reprend où elle en était si le conteneur
s'arrête. Le cache d'images du nginx du site est passé à 12 Go (`deploy/nginx.conf.template`) :
vérifier la place libre du VPS avant, les images et la base y sont sur le même disque.

**Ensuite, à chaque déploiement** (`.github/workflows/deploy.yml`, lancé à la main depuis l'onglet
Actions) : GitHub se connecte au VPS en SSH, fait `git pull` et lance `deploy/deploy.sh`. La
construction lance d'abord les tests, TypeScript, ESLint et knip ; si elle échoue, l'ancienne
version reste en ligne. Une fois les conteneurs redémarrés, le script vérifie que l'API répond. Les
secrets du dépôt (Settings › Secrets and variables › Actions) : `VPS_HOST`, `VPS_USER`, `VPS_PORT`
et `VPS_FINGERPRINT`, les mêmes valeurs que pour le site ; `VPS_PATH`, le dossier de ce clone ; et
`VPS_SSH_KEY`, **une clé propre à ce dépôt, jamais celle du site**.

Chaque clé du déploiement est réservée à son dépôt dans `~/.ssh/authorized_keys` du VPS, par une
commande imposée en tête de sa ligne : SSH lance alors cette commande-là, quoi que demande le
workflow. La clé du site, imposée au déploiement du site, ne déploierait donc que le site. Une clé
à part, tirée hors du VPS :

```sh
ssh-keygen -t ed25519 -N '' -C deploy-pokedex-data -f deploy-pokedex-data
# deploy-pokedex-data : le secret VPS_SSH_KEY de ce dépôt (puis effacer le fichier)
# deploy-pokedex-data.pub : sa ligne dans ~/.ssh/authorized_keys du VPS, précédée de sa commande
```

Sa ligne dans `~/.ssh/authorized_keys` (le dossier du clone à adapter), à côté de celle du site :

```
restrict,command="cd /chemin/du/clone/pokedex-data && git pull --ff-only && sh deploy/deploy.sh" ssh-ed25519 AAAA… deploy-pokedex-data
```

**Lancer une tâche à la main** (de nouvelles cartes, relire tout le catalogue…) ; une longue, comme
plus haut, avec `-d --name …` au lieu de `--rm` :

```sh
docker compose run --rm ingest bun src/ingest.ts cards
docker compose run --rm ingest bun src/ingest.ts catalog --refresh
```

Une tâche déjà en cours ailleurs n'est pas doublée ; arrêtée net (conteneur tué, VPS redémarré),
elle ne bloque plus sa relance au bout de 5 min (elle donne signe de vie chaque minute).
**La surveillance** : `/v1/health` (par le
site : `https://pokecodex.fr/api/health`) répond 200 quand chaque tâche à rythme a réussi
récemment (deux intervalles au plus : les prix en 12 h, les sauvegardes en 2 jours, les espèces en
60 jours) et que le guide des prix n'est pas figé, 503 sinon, avec les tâches en retard. Un trou
dans l'historique des prix ne se rattrape jamais (Cardmarket n'en garde pas).

Ne jamais lancer `docker compose down -v`, qui effacerait les volumes (`data` : la base et
l'historique des prix ; `backups` ; `images`).

## Sauvegardes

Chaque jour, le service `ingest` copie la base dans le volume `backups` : `data-AAAA-MM-JJ.db.gz`
(7 gardées), vérifiée (`PRAGMA quick_check`) et écrite sous un nom provisoire avant de prendre sa
place (`tmp-…` tant qu'elle s'écrit). Ce volume est sur le même disque que la base : copiez-le
aussi ailleurs. Pour en sortir les fichiers, dans `./sauvegardes` (que git ignore ; vidé d'abord,
il ne garde que ce qu'a le volume, sans une copie en cours d'écriture), avec `docker compose cp`,
qui les écrit au nom de l'utilisateur qui le lance. Les conteneurs ne le pourraient pas, même
`--user root` : ils n'ont aucun droit (`cap_drop: ALL`), ni d'écrire dans un dossier du VPS qui
ne leur appartient pas, ni de changer un propriétaire.

```sh
rm -rf sauvegardes && mkdir sauvegardes
docker compose cp ingest:/backups/. sauvegardes/ && rm -f sauvegardes/tmp-*
```

Chaque nuit, hors du VPS, avec `rclone` (configuré une fois, `rclone config`) : dans la crontab de
l'utilisateur du déploiement (`crontab -e`), ici à 4 h 45, le dossier du clone à adapter. Le
stockage distant garde 90 jours :

```sh
45 4 * * * cd /chemin/du/clone/pokedex-data && rm -rf sauvegardes && mkdir sauvegardes && docker compose cp ingest:/backups/. sauvegardes/ && rm -f sauvegardes/tmp-* && rclone copy sauvegardes distant:pokedex-data-sauvegardes && rclone delete --min-age 90d distant:pokedex-data-sauvegardes
```

**Restaurer une sauvegarde** : arrêter l'API et les tâches (une tâche lancée à la main aussi :
`docker stop pokedex-data-cards`), remettre la copie à la place de la base, sans les fichiers
`-wal` et `-shm` de l'ancienne, puis redémarrer. En tant que `bun`, l'utilisateur des conteneurs,
à qui appartiennent la base et son dossier (pas de `chown`) :

```sh
docker compose stop api ingest
docker compose run --rm --no-deps -v "$PWD/sauvegardes:/restore:ro" api sh -c 'rm -f /data/data.db-wal /data/data.db-shm && gunzip -c /restore/data-AAAA-MM-JJ.db.gz > /data/data.db'
docker compose up -d
```
