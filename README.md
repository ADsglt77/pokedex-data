# Pokédex · données

L'API privée des données du Pokédex de cartes Pokémon japonaises et françaises (PokéCodex, en ligne
à https://pokecodex.fr) : les espèces (PokéAPI), le catalogue des cartes japonaises et françaises et
leurs images (Pokécardex), les prix Cardmarket du jour et leur historique. Un Worker Cloudflare
(Hono, D1, R2) les relit à leur rythme (ses tâches d'ingestion : un Cron, des Workflows), les range
dans D1 et R2, et les rend au site, et aux clients qui ont un token, à https://api.pokecodex.fr :
sans token, aucune donnée.

```sh
bun install
bun run dev            # le Worker, sur http://127.0.0.1:8787 (sa D1 et son R2 locaux, .wrangler/)
bun run ingest <tâche> # un passage d'une tâche, tout de suite, dans ce Worker (plus bas)
bun run ingest cards   # les nouvelles cartes : catalogue, puis leurs images et leur historique
bun run ingest setup   # première installation : espèces, catalogue, prix, images, historique
bun run test           # tests, dans le moteur de Cloudflare (accès, état, prix et historique,
                       # catalogue des deux langues, lecture de Pokécardex, images, liste de
                       # souhaits, passages des tâches)
bun run db:generate    # après une modification de worker/schema.ts : sa migration
bun run typecheck      # TypeScript
bun run lint           # ESLint, puis knip (code mort)
bun run format         # Prettier
```

Il faut **Node 22 ou plus** pour Wrangler et Vitest (sur un Windows ARM64, Node ARM64) ; Bun reste
le gestionnaire de paquets.

## L'API

**Deux entrées, la même API** (`worker/index.ts`). Le site la joint par une **liaison de service**
(`SiteEntrypoint`, que seul son Worker peut joindre) : ni token, ni réseau, ni limite. Les autres
clients (un script, une autre app), par **https://api.pokecodex.fr**, l'entrée par défaut du
Worker : des limites par adresse (`worker/limits.ts`, comptées par Cloudflare) : 300 demandes par
10 s, 20 pour `/v1/histories` et `/v1/wants` ; au-delà, 429 avec `Retry-After`. Puis le token :
`Authorization: Bearer <token>`. Sans lui, ou avec un autre : 401, sans corps (une adresse inconnue
aussi : rien ne dit ce qui existe). Les tokens sont dans `API_TOKENS` (`nom:token,…`, un par
client ; `.env` en développement, un secret du Worker en ligne). Un token se tire au hasard :
`openssl rand -hex 32`, 32 caractères au moins.

```sh
curl -H "Authorization: Bearer $TOKEN" https://api.pokecodex.fr/v1/catalog/fr/sets
```

Un token se révoque en le retirant d'`API_TOKENS`. Pas de CORS : une page d'un autre site ne la
lit pas, un client HTTP oui. Ne jamais mettre un cache partagé devant cette adresse : les images y
sont `public, immutable`, il les rendrait sans token.

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

La forme de chaque réponse : `src/contract.ts`, dont le site garde une copie. Les réponses portent
un ETag (304 tant qu'elles n'ont pas changé). Où vit chaque donnée : la base (D1, `worker/schema.ts`)
pour ce qui se lit ligne à ligne (prix, historiques, produits, état des tâches) ; R2 pour les
images (`images/…`) et les grosses réponses calculées par les tâches (`snapshots/…` : espèces,
catalogue).

Les chemins des images ne nomment aucune source : `/v1/images/cards/<série>/<n>-<md|hd>.webp`,
`/v1/images/sets/<série>-<md|hd>.webp` (celles des cartes japonaises ; les françaises, avec `fr/`
avant la série : `/v1/images/cards/fr/<série>/…`, `/v1/images/sets/fr/<série>-…`),
`/v1/images/types/<n>.webp`, `/v1/images/rarities/<n>.webp`, `/v1/images/species/<n>.png`. Seule
la tâche `images` connaît leur adresse d'origine.

## Les tâches d'ingestion

| Tâche | Rythme | Ce qu'elle fait |
|---|---|---|
| `species` | chaque mois | Les espèces, d'après PokéAPI |
| `catalog` | à la demande | Le catalogue des cartes japonaises, puis des françaises, d'après Pokécardex (une page par série, toutes les 3 s : environ 20 minutes la première fois pour les japonaises, 13 de plus pour les françaises, 250 séries ; `--refresh` relit toutes les séries) |
| `images` | à la demande | Les images qui manquent, toutes d'avance : logos, icônes, Pokémon, scans des cartes japonaises et françaises (environ 1,5 Go la première fois pour les japonaises, 1 à 1,4 Go de plus pour les françaises) |
| `prices` | toutes les 6 h | Le guide des prix public de Cardmarket, et l'historique du jour |
| `history` | à la demande | Les 180 derniers jours de prix de chaque carte, une fois par carte, d'après Pokécardex (environ 23 h la première fois pour les japonaises, 21 h de plus pour les françaises) |

Elles tournent dans le Worker (`worker/ingest/`). Chaque passage est un **Workflow** (`ingest`),
par étapes (une série, 50 cartes, 100 Pokémon…) : une étape en échec (une panne) est réessayée
seule, deux fois, et un passage arrêté reprend où il en était. Le **Cron** (toutes les heures,
`worker/index.ts`) lance les tâches à rythme quand leur intervalle est écoulé ; après un échec, 10
min plus tard, puis 20, 40… jusqu'à 6 h. Les autres, à la demande : quand de nouvelles cartes
sortent, `bun run ingest cards` enchaîne le catalogue, puis les images et l'historique (seulement
ce qui manque : les nouvelles cartes). Chaque tâche reste lançable seule (`bun run ingest prices`,
`bun run ingest catalog --refresh`…). Une tâche ne tourne qu'une fois à la fois, et `catalog`
jamais en même temps que `history` (elles lisent les mêmes pages : deux à la fois doubleraient leur
rythme). Un passage arrêté net (son Workflow terminé, le Worker de `bun run dev` arrêté) est noté
interrompu quand sa tâche repart.

## En développement

`bun run dev` applique les migrations à la D1 locale, puis sert le Worker sur le port 8787, sa D1
et son R2 dans `.wrangler/` ; le site (`bun dev` dans `../pokedex`) le joint tout seul, par sa
liaison de service. Les tâches y tournent comme en ligne, dans ce Worker (`bun run ingest …`) ; le
Cron, lui, ne passe pas tout seul : `curl http://127.0.0.1:8787/__scheduled` le déclenche. Un
passage se suit dans le journal du terminal et sur la page Données du site.

La première fois, `bun run ingest setup` remplit tout : les espèces, le catalogue, les prix (après
le catalogue : le prix d'une carte d'une série récente en dépend), les images et l'historique
(environ deux jours, cartes françaises comprises, dont 44 h d'historique ; relancé après un arrêt,
il reprend où il en était). Les images doivent toutes être copiées : l'API n'en copie aucune
elle-même, une image qui manque répond 404.

Pour essayer l'entrée d'Internet, un `.env` (ignoré par git), sur le modèle de `.env.example` :

```sh
echo "API_TOKENS=moi:$(openssl rand -hex 32)" > .env
```

**Le journal** : une ligne par évènement, alignée, à l'heure de Paris (pas les requêtes une à
une) : un token refusé, un débit dépassé (une ligne par minute au plus, jamais le token), une
erreur de l'API.

## Déploiement (le VPS du site)

> **Périmé** : l'API passera sur Cloudflare Workers, reliée à GitHub, à la fin du développement
> (ses tâches d'ingestion aussi). Ce qui suit décrit l'ancien VPS (Docker, Caddy), qui sera
> retiré ; il ne marche plus tel quel (l'ancien serveur, Elysia, n'existe plus).

L'API tourne sur le même VPS que le site, dans ses propres conteneurs : le site la joint par un
réseau Docker commun, `pokedex-net`, à l'adresse `http://data-api:3001` (le public passe par
Caddy, puis le nginx du site, puis elle) ; un seul port publié, **sur 127.0.0.1 seulement**,
`3002`, son entrée d'Internet, que Caddy relaie à `https://api.pokecodex.fr`. Sur un nouveau VPS,
à installer avant le site.

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
4. Sur une base vide, le catalogue d'abord (environ 33 minutes : les japonaises, puis les
   françaises) : le prix d'une carte d'une série récente en dépend, et un premier guide des prix
   lu sans lui resterait faux dans l'historique.
   ```sh
   docker compose run --rm ingest bun src/ingest.ts catalog
   ```
5. Puis, tout de suite, l'API et les tâches à rythme (le service `ingest` : les espèces, les prix
   toutes les 6 h). Elles n'attendent pas les cartes : un guide des
   prix pas lu le jour même manque pour toujours à l'historique. Docker relance ces deux services
   après un arrêt ou un redémarrage du VPS (`restart: unless-stopped`).
   ```sh
   docker compose up -d
   ```
6. Le reste des cartes, japonaises et françaises (le catalogue est déjà lu ; leurs images, 2,5 à
   3 Go en tout ; puis leur historique : environ 44 h la première fois, 23 pour les japonaises et
   21 pour les françaises), dans un conteneur ponctuel, sans garder la connexion SSH ouverte
   (`-T` : sans terminal, son journal a des lignes simples, pas une barre redessinée) :
   ```sh
   docker compose run -d -T --name pokedex-data-cards ingest bun src/ingest.ts cards
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
   docker compose run -d -T --name pokedex-data-cards ingest bun src/ingest.ts cards
   ```

**Les cartes françaises, sur un VPS déjà en place** (une seule fois) : déployer l'API des données
d'abord, puis, **seulement une fois le catalogue et les images français en place, le site** (plus
bas). Les routes japonaises de l'API ne changent pas, sauf la copie d'images à la demande,
supprimée : entre les deux déploiements, une image que la tâche `images` n'a pas encore copiée
répond 404 au site d'avant (il montre la carte de substitution) au lieu d'être copiée. Au
démarrage, l'API passe deux étapes du schéma : la 16 (le signe de vie des tâches) et la 17 (la
langue dans les clés du catalogue : les cartes japonaises deviennent `ja`, rien ne se perd). Le
code d'avant (celui d'`origin/main` du 20 octobre 2026) n'en connaît que 15. **Ces étapes ne se
défont pas en redéployant le code d'avant** : l'image d'avant refuse alors de démarrer (« data.db
en est à l’étape 17 du schéma, ce code n’en connaît que 15 (un code plus ancien ?) »), et aucune
copie de la base d'avant n'existe (plus de sauvegarde, « Sauvegardes : aucune ») : la seule voie
après un problème est de corriger en avant. Avant de lancer le déploiement, sur le VPS, aucune
tâche lancée à la main ne doit tourner : le déploiement ne redémarre que `api` et `ingest`, et un
conteneur ponctuel garderait le code d'avant, qui écrirait le catalogue sans sa langue sur des
clés qui l'exigent. `docker ps` ne doit montrer ni `pokedex-data-cards`, ni un autre conteneur
lancé par `docker compose run` (une tâche, `setup`) ; sinon, l'arrêter (`docker stop
pokedex-data-cards`, puis `docker rm` : relancée après le déploiement, la tâche reprend où elle en
était).

Puis déployer l'API (le workflow, plus bas). Tant que `catalog` n'a pas tourné, les routes
françaises (`/v1/catalog/fr/…`) répondent 404 ; le site d'avant ne les demande pas. Le premier
remplissage français, dans un conteneur ponctuel (comme à l'étape 6) :

```sh
docker compose run -d -T --name pokedex-data-cards ingest bun src/ingest.ts cards
docker logs -f pokedex-data-cards
```

Il enchaîne le catalogue (environ 15 minutes, 250 séries et 25 600 cartes), leurs images (1 à
1,4 Go de plus dans le volume `images`) puis leur historique (environ 21 heures) ; ce que les
japonaises ont déjà n'est pas refait, et chaque étape reprend où elle en était si le conteneur
s'arrête. Le cache d'images du nginx du site est passé à 12 Go (`deploy/nginx.conf.template`) :
vérifier la place libre du VPS avant, les images et la base y sont sur le même disque.

**Le site ensuite, quand le catalogue et les images français sont en place** (l'historique, 21 h
de plus, n'est pas un préalable : il continue après). L'API ne copie aucune image à la demande :
un site déployé avant montrerait « Catalogue indisponible » pour les cartes françaises, et des
cartes de substitution à la place de leurs scans. Le journal de `cards` donne chaque étape et son
issue (sans `^` : lancé avec un terminal, sans `-T`, chaque en-tête d'étape commence par un code
de couleur ; `-a` : `grep` lit alors quand même le journal comme du texte) :

```sh
docker logs pokedex-data-cards 2>&1 | grep -aE '\[[0-9]/3\]|Terminée|Échec|Étape ignorée'
```

Attendre `[3/3] Historique des prix`, précédé de deux `✓ Terminée` :

```
[1/3] Catalogue
✓ Terminée en 15 min 02 s
[2/3] Images copiées
✓ Terminée en 1 h 10 min
[3/3] Historique des prix
```

Puis déployer le site (son README). Un `✗ Échec` (une série ou une image en erreur) ou une
`✗ Étape ignorée` (la même tâche, ou `history` pour `catalog`, déjà en cours ailleurs) :
arrêter le conteneur (`docker stop pokedex-data-cards`, puis `docker rm pokedex-data-cards`) et
relancer `cards`, qui ne refait que ce qui manque, jusqu'à ces deux `✓`.

**Les images ne s'ajoutent que par la tâche `images`.** Des fichiers déposés autrement dans le
volume `images` (`docker cp`, `rsync`, copiés d'une autre machine) y appartiennent à `root` : la
tâche, qui tourne en tant que `bun` sans aucun droit (`cap_drop: ALL`), ne peut plus écrire dans
leurs dossiers, chaque image y échoue (`EACCES`) et elle s'arrête à la 20e erreur. Après un tel
dépôt, rendre le volume à `bun` (le seul droit ajouté, le temps de la commande : changer un
propriétaire) :

```sh
docker compose run --rm --no-deps --user root --cap-add CHOWN ingest chown -R bun:bun /images
```

Un dépôt n'épargne d'ailleurs que les scans des cartes déjà notées avec leur scan : celui d'une
carte à chercher est recopié de toute façon (une renumérotation de sa série a pu laisser à son
chemin le scan d'une autre carte : « Images », `docs/donnees.md`).

**Ensuite, à chaque déploiement** (`.github/workflows/deploy.yml`, lancé à la main depuis l'onglet
Actions) : GitHub se connecte au VPS en SSH, fait `git pull` et lance `deploy/deploy.sh`. La
construction lance d'abord les tests, TypeScript, ESLint et knip ; si elle échoue, l'ancienne
version reste en ligne. Une fois les conteneurs redémarrés, le script vérifie que l'API répond.
Il ne redémarre que `api` et `ingest` : un conteneur ponctuel (`pokedex-data-cards`, ou une autre
tâche lancée par `docker compose run`, que montre `docker ps`) garde le code d'avant et continue
d'écrire la base. Le script le signale pour `pokedex-data-cards` ; l'arrêter (`docker stop`, puis
`docker rm`) et relancer sa tâche après le déploiement : elle reprend où elle en était. Les
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
plus haut, avec `-d -T --name …` au lieu de `--rm` :

```sh
docker compose run --rm ingest bun src/ingest.ts cards
docker compose run --rm ingest bun src/ingest.ts catalog --refresh
```

Une tâche déjà en cours ailleurs n'est pas doublée, et `catalog` et `history`, qui lisent toutes
deux les pages de Pokécardex (une toutes les 3 s en tout), ne tournent jamais en même temps : un
`catalog --refresh` lancé pendant l'historique d'un conteneur `cards` ne lance rien (le relancer
après). Arrêtée net (conteneur tué, VPS redémarré), une tâche ne bloque plus sa relance au bout de
5 min (elle donne signe de vie chaque minute).

**L'adresse https://api.pokecodex.fr** (une fois, dans cet ordre) :

1. Dans la zone DNS OVH, un enregistrement `A` : `api.pokecodex.fr` vers l'IPv4 du VPS (la même
   que `pokecodex.fr`).
2. Le Caddyfile du site (`deploy/Caddyfile` du dépôt `pokedex`, qui a le bloc `api.pokecodex.fr`),
   installé et rechargé (son README, étape 3) : Caddy obtient le certificat ; l'adresse répond 502
   tant que l'étape 4 n'est pas faite.
3. Un token par client, ajouté à `API_TOKENS` dans `.env` (`openssl rand -hex 32`), par exemple
   `API_TOKENS=pokedex:<token du site>,moi:<un autre token>` ; jamais celui du site.
4. Le déploiement (`deploy/deploy.sh`) : il publie le port 3002 et vérifie, à travers Caddy, que
   `https://api.pokecodex.fr/v1/status` répond 401 sans token (en rouge sinon).
5. Un essai : `curl -H "Authorization: Bearer <token>" https://api.pokecodex.fr/v1/status`.

`Strict-Transport-Security` (`includeSubDomains`, posé par le site) couvre déjà ce sous-domaine,
servi en https par Caddy.

**La surveillance** : `/v1/health` (par le
site : `https://pokecodex.fr/api/health`) répond 200 quand chaque tâche à rythme a réussi
récemment (deux intervalles au plus : les prix en 12 h, les espèces en 60 jours) et que le guide des prix n'est pas figé, 503 sinon, avec les tâches en retard. Un trou
dans l'historique des prix ne se rattrape jamais (Cardmarket n'en garde pas).

Ne jamais lancer `docker compose down -v`, qui effacerait les volumes (`data` : la base et
l'historique des prix, sans aucune sauvegarde ; `images`).

## Sauvegardes : aucune

Plus aucune sauvegarde (octobre 2026, décision de l'utilisateur) : ni copie quotidienne de la
base, ni copie hors du VPS, ni procédure de restauration. Une panne du disque du VPS, une base
abîmée ou un `docker compose down -v` perdent pour toujours l'historique des prix (Cardmarket
n'en garde pas) ; les espèces, le catalogue et les images se relisent (`setup`, environ deux
jours), l'historique de Pokécardex sur 180 jours seulement.

Sur un VPS installé avec l'ancien système, une fois ce code déployé, ce qui en reste ne se retire
qu'à la main : la ligne de la crontab qui copiait les sauvegardes (`crontab -e` : celle qui finit
par `rclone … distant:pokedex-data-sauvegardes`), le dossier `sauvegardes` du clone et le volume
des copies, que Compose ne supprime jamais seul (son nom vient du dossier du clone :
`docker volume ls`). Les copies déjà envoyées sur le stockage distant y restent jusqu'à ce qu'on
les supprime (`rclone purge distant:pokedex-data-sauvegardes`).

```sh
rm -rf sauvegardes
docker volume rm pokedex-data_backups
```
