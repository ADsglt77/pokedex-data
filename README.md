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
passage se suit dans le journal du terminal ; en ligne, dans le tableau de bord (Workflows ›
`ingest`) ou par `npx wrangler tail pokedex-data`. La page Réglages du site ne montre que les
tâches en retard ou en échec.

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

## Mise en ligne

Le Worker `pokedex-data`, à https://api.pokecodex.fr (un domaine personnalisé, `routes` de
`wrangler.jsonc`, sans adresse `workers.dev`) ; le site le joint par sa liaison de service.
**Workers Builds** (Cloudflare relié au dépôt GitHub) le déploie à chaque push sur `main` :
`bun run ci` (typecheck, lint, test ; un échec arrête là), puis `bun run deploy` (les migrations
de la D1 en ligne, puis le Worker). Le guide complet, pour les deux Workers :
`../pokedex/docs/deploiement.md` (le dépôt du site).

Les tokens des autres clients (`API_TOKENS`, `nom:token,…`, plus haut) sont un secret du Worker,
posé une fois, puis de nouveau à chaque client ajouté ou retiré :

```sh
npx wrangler secret put API_TOKENS
```

Sur son entrée d'Internet (`worker/index.ts`) : https seulement (`http://` : 301 vers `https://`),
lecture seule (405 pour tout autre verbe que `GET` et `HEAD`), et les en-têtes d'une API :
`Strict-Transport-Security` (un an, sous-domaines compris), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`,
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` et
`X-Robots-Tag: noindex, nofollow`.

Les tâches à la demande se lancent dans le Worker en ligne avec `--remote` (la première fois,
`setup` : plus haut) :

```sh
bun run ingest cards --remote
bun run ingest catalog --refresh --remote
```

**La surveillance** : `/v1/health` (par le site : `https://pokecodex.fr/api/health`) répond 200
quand chaque tâche à rythme a réussi récemment (deux intervalles au plus : les prix en 12 h, les
espèces en 60 jours) et que le guide des prix n'est pas figé, 503 sinon, avec les tâches en
retard. Un trou dans l'historique des prix ne se rattrape jamais (Cardmarket n'en garde pas).

## Sauvegardes : aucune

Aucune sauvegarde (octobre 2026, décision de l'utilisateur) : ni copie de la base, ni procédure de
restauration. Seul reste l'historique de la base D1 que Cloudflare garde de lui-même, 30 jours
(Time Travel). Une base abîmée ou effacée, vue plus de 30 jours après, perd pour toujours
l'historique des prix (Cardmarket n'en garde pas) ; les espèces, le catalogue et les images se
relisent (`setup`, environ deux jours), l'historique de Pokécardex sur 180 jours seulement.

Les copies de l'ancien système de sauvegarde, envoyées sur un stockage distant, y restent jusqu'à
ce qu'on les supprime (`rclone purge distant:pokedex-data-sauvegardes`).
