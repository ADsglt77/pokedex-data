# Pokédex · données

L'API privée des données du Pokédex de cartes Pokémon japonaises et françaises (PokéCodex, en ligne
à https://pokecodex.fr) : les espèces (PokéAPI), le catalogue des cartes japonaises et françaises et
leurs images (TCGdex, copiés par l'importateur `pokecodex-importer`, dépôt `../pokecodex-api`), les
prix Cardmarket du jour et leur historique. Un Worker Cloudflare (Hono, D1, R2) les relit à leur
rythme (ses tâches d'ingestion : un Cron, des Workflows), les range dans D1 et R2, et les rend au
site, et aux clients qui ont un token, à https://api.pokecodex.fr : sans token, aucune donnée.

```sh
bun install
bun run dev            # le Worker, sur http://127.0.0.1:8787 (sa D1 et son R2 locaux, .wrangler/)
bun run ingest <tâche> # un passage d'une tâche, tout de suite, dans ce Worker (plus bas)
bun run ingest cards   # le catalogue, tout de suite (sans attendre le Cron)
bun run ingest setup   # première installation : espèces, catalogue, images des Pokémon, prix
bun run test           # tests, dans le moteur de Cloudflare (accès, état, prix et historique,
                       # catalogue des deux langues d'après TCGdex, images, liste de souhaits,
                       # passages des tâches, migrations)
bun run db:generate    # après une modification de worker/schema.ts : sa migration (puis
                       # `bun run format`, pour ses `meta/*.json`, que `bun run ci` vérifie)
bun run typecheck      # TypeScript
bun run lint           # ESLint, knip (code mort), puis le contrat (quand le site est à côté)
bun run format         # Prettier
```

Il faut **Node 22 ou plus** pour Wrangler et Vitest (sur un Windows ARM64, Node ARM64) ; Bun reste
le gestionnaire de paquets.

## L'API

**Deux entrées, la même API** (`worker/index.ts`). Le site la joint par une **liaison de service**
(`SiteEntrypoint`, que seul son Worker peut joindre) : ni token, ni réseau, ni limite. Les autres
clients (un script, une autre app), par **https://api.pokecodex.fr**, l'entrée par défaut du Worker,
en https seulement. Une limite par réseau (l'adresse, ramenée à son /64 en IPv6 :
`worker/limits.ts`, comptée par Cloudflare) : 300 demandes par 10 s. Puis le token : `Authorization:
Bearer <token>`. Sans lui, ou avec un autre : 401, sans corps (une adresse inconnue aussi : rien ne
dit ce qui existe). Puis les routes coûteuses, par client (un token qui a fui ne gagne rien à
changer d'adresse dans une même région : Cloudflare tient ses compteurs par lieu) : 20 demandes par
10 s pour `/v1/histories`, 5 pour `/v1/wants` (comme sur le site). Au-delà d'une limite, 429 avec
`Retry-After` ; les chemins sont lus décodés, comme Hono les route (`/v1/%77ants` est `/v1/wants`).
Un token envoyé en http a circulé en clair : à changer. Le Worker répond alors 403, sans redirection
; mais en ligne, la zone (« Always Use HTTPS ») redirige le http avant lui. Les tokens sont dans
`API_TOKENS` (`nom:token,…`, un par client ; `.env` en développement, un secret du Worker en ligne).
Un token se tire au hasard : `openssl rand -hex 32`, 32 caractères au moins.

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
| `GET /v1/catalog/sets`, `/v1/catalog/sets/:id` | Les séries ; toutes les cartes d'une série (son id chez TCGdex : `SV2a`, `SM1+`, encodé `SM1%2B`) |
| `GET /v1/catalog/fr/species/:id`, `/v1/catalog/fr/sets`, `/v1/catalog/fr/sets/:id` | Les mêmes, pour les cartes françaises (leur sortie : celle en France) |
| `GET /v1/prices?ids=…` | Les prix du jour des cartes demandées (ids Cardmarket) |
| `GET /v1/prices/:id`, `/v1/histories?ids=…` | L'historique d'une carte ; de plusieurs |
| `GET /v1/wants?ids=…` | La ligne de chaque carte pour la liste de souhaits Cardmarket : aujourd'hui toujours `null` (`docs/donnees.md`) |
| `GET /v1/status` | Chaque tâche : son identifiant, son libellé et son état |
| `GET /v1/images/…` | Une image (404 tant qu'elle n'est pas copiée : rien n'est copié à la demande) |
| `GET /v1/health` | **Sans token** : 200, ou 503 si une tâche à rythme est en retard (le catalogue compris) ou les prix figés |

La forme de chaque réponse : `src/contract.ts`, dont le site garde une copie, vérifiée par `bun run
lint` quand le site est à côté ; une forme qui change suit la règle « élargir puis restreindre »
(`../pokedex/docs/deploiement.md`). Les réponses portent un ETag (304 tant qu'elles n'ont pas
changé). Où vit chaque donnée : la base (D1, `worker/schema.ts`) pour ce qui se lit ligne à ligne
(prix, historiques, produits, miroir du catalogue, état des tâches) ; R2 pour les images et les
grosses réponses calculées par les tâches (`snapshots/…` : espèces, catalogue). Le catalogue est
lu dans la base de l'importateur (`pokecodex-cards`, liaison `CARDS`, lue seulement), et les images
des cartes dans ce qu'il copie dans le même bucket R2 (`cards/…`, liaison `IMPORTS`, lue seulement).

Les chemins des images ne nomment aucune source : `/v1/images/cards/<langue>/<série>/<carte>-<md|hd>.webp`
(le scan d'une carte, `ja` ou `fr` ; ses parties encodées comme les clés de l'importateur :
`cards/<langue>/<série>/<carte>.webp`), `/v1/images/sets/<langue>/<série>.webp` (le logo d'une
série), `/v1/images/species/<n>.png` et `/v1/images/species/artwork/<n>.webp` (le sprite et
l'illustration d'un Pokémon). Le catalogue donne le chemin de chaque image (`ImageKey` du contrat).

## Les tâches d'ingestion

| Tâche | Rythme | Ce qu'elle fait |
|---|---|---|
| `species` | chaque mois | Les espèces, d'après PokéAPI |
| `catalog` | chaque jour | Le catalogue des cartes japonaises, puis des françaises, d'après la base de l'importateur (TCGdex, sans les séries de Pokémon TCG Pocket) : ses réponses dans R2, et son miroir (`catalog_cards`) que lisent les prix. Aucune requête vers TCGdex |
| `sprites` | à la demande | Le sprite et le PNG de l'illustration des 1 025 Pokémon, d'après PokéAPI (seulement ceux qui manquent) |
| `prices` | toutes les 6 h | Le guide des prix public de Cardmarket, et l'historique du jour |

Elles tournent dans le Worker (`worker/ingest/`). Chaque passage est un **Workflow** (`ingest`),
par étapes (une langue du catalogue, 100 Pokémon…) : une étape en échec (une panne) est réessayée
seule, deux fois, et un passage arrêté reprend où il en était. Le **Cron** (toutes les heures,
`worker/index.ts`) lance les tâches à rythme quand leur intervalle est écoulé depuis le début de
leur dernier passage, à 10 min près : `prices` toutes les 6 h, `catalog` chaque jour ; après un
échec, au Cron suivant, puis de plus en plus tard, jusqu'à 6 h (`docs/donnees.md`). Chaque tâche
reste lançable seule (`bun run ingest prices`, `bun run ingest catalog`…). Une tâche ne tourne
qu'une fois à la fois. Un passage arrêté net (son Workflow terminé, le Worker de `bun run dev`
arrêté) est noté interrompu quand sa tâche repart.

Les images des cartes et les logos des séries ne sont pas copiés par ce Worker : l'importateur
`pokecodex-importer` les copie de TCGdex dans R2 (`cards/<langue>/<série>/<carte>.webp`, la petite
image `….low.webp`, le logo `_logo.webp`), et ce Worker les sert tels quels.

## En développement

`bun run dev` applique les migrations à la D1 locale, puis sert le Worker sur le port 8787, sa D1
et son R2 dans `.wrangler/` ; le site (`bun dev` dans `../pokedex`) le joint tout seul, par sa
liaison de service. Les tâches y tournent comme en ligne, dans ce Worker (`bun run ingest …`) ; le
Cron, lui, ne passe pas tout seul : `curl http://127.0.0.1:8787/__scheduled` le déclenche. Un
passage se suit dans le journal du terminal ; en ligne, dans le tableau de bord (Workflows ›
`ingest`) ou par `npx wrangler tail pokedex-data`. La page Réglages du site ne montre que les
tâches en retard ou en échec.

En local, `CARDS` (la base de l'importateur) et `IMPORTS` (ses images) sont vides tant qu'on ne les
remplit pas, ou qu'on ne les fait pas viser les données en ligne de l'importateur (en lecture : une
liaison `remote`) ; `FILES` (nos images et nos réponses) reste local, et une tâche lancée en local
n'écrit jamais dans le bucket en ligne. Sans cartes, la tâche `catalog` échoue (« base de
l'importateur vide ») et les réponses du catalogue répondent 404.

La première fois, `bun run ingest setup` remplit tout : les espèces, le catalogue, les images des
Pokémon, puis les prix (après le catalogue : le prix d'une carte d'une série récente en dépend).
Les illustrations des Pokémon sont servies en PNG tant que leur WebP n'est pas converti
(`docs/donnees.md`).

Pour essayer l'entrée d'Internet (http://127.0.0.1:8787/v1/…, en http, sans redirection : le
Worker y voit son adresse locale, pas celle de `routes`), un `.env` (ignoré par git), sur le
modèle de `.env.example` :

```sh
echo "API_TOKENS=moi:$(openssl rand -hex 32)" > .env
```

**Le journal** : une ligne par évènement, alignée, à l'heure de Paris (pas les requêtes une à
une) : un token refusé, un débit dépassé, un token envoyé en http (son client nommé : à changer ;
une ligne par minute au plus, jamais le token), une erreur de l'API.

## Mise en ligne

Le Worker `pokedex-data`, à https://api.pokecodex.fr (un domaine personnalisé, `routes` de
`wrangler.jsonc`, sans adresse `workers.dev`) ; le site le joint par sa liaison de service.
**Workers Builds** (Cloudflare relié au dépôt GitHub) le déploie à chaque push sur `main` :
`bun run ci` (format, typecheck, lint, test ; un échec arrête là), puis `bun run deploy` (les
migrations de la D1 en ligne, puis le Worker ; jamais celles de la base de l'importateur, qui sont
les siennes). Le guide complet, pour les deux Workers : `../pokedex/docs/deploiement.md` (le dépôt
du site).

La tâche `catalog` lit les colonnes des logos que l'importateur ajoute à sa base (`sets.logo_status`,
`sets.logo_r2_key`, novembre 2026) : sa migration doit être passée en ligne avant ce Worker.

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

Une tâche se lance dans le Worker en ligne avec `--remote` (la première fois, `setup` : plus haut) :

```sh
bun run ingest cards --remote
bun run ingest sprites --remote
```

**La surveillance** : `/v1/health` (par le site : `https://pokecodex.fr/api/health`) répond 200
quand chaque tâche à rythme a réussi récemment (deux intervalles au plus : les prix en 12 h, le
catalogue en 2 jours, les espèces en 60 jours) et que le guide des prix n'est pas figé, 503 sinon,
avec les tâches en retard. Un trou dans l'historique des prix ne se rattrape jamais (Cardmarket
n'en garde pas).

## Sauvegardes : aucune

Aucune sauvegarde (octobre 2026, décision de l'utilisateur) : ni copie de la base, ni procédure de
restauration. Seul reste l'historique de la base D1 que Cloudflare garde de lui-même, 30 jours
(Time Travel). Une base abîmée ou effacée, vue plus de 30 jours après, perd pour toujours
l'historique des prix (Cardmarket n'en garde pas) ; les espèces, le catalogue et les images des
Pokémon se relisent (`setup`).

Les copies de l'ancien système de sauvegarde, envoyées sur un stockage distant, y restent jusqu'à
ce qu'on les supprime (`rclone purge distant:pokedex-data-sauvegardes`).
