# CLAUDE.md

L'API privée des données du Pokédex de cartes Pokémon japonaises et françaises (le site : le dépôt
`pokedex`, à côté) : espèces (PokéAPI), catalogue et images des cartes japonaises et françaises
(TCGdex, copiés par l'importateur `pokecodex-importer`, dépôt `../pokecodex-api` : sa base D1
`pokecodex-cards` et ses images R2 `cards/…`, lues seulement), prix Cardmarket et leur
historique. Tout tient dans un **Worker** (`worker/`, Cloudflare Workers : Hono, D1 par son schéma
Drizzle, R2) : l'API, et les **tâches d'ingestion** (`worker/ingest/`), un Workflow par passage,
les tâches à rythme lancées par un Cron toutes les heures. En ligne depuis le 29 octobre 2026 (le
guide : `../pokedex/docs/deploiement.md`). Deux entrées : le site, par sa liaison de service
(`SiteEntrypoint`, ni token ni limite) ; ses autres clients, chacun son token, par
`https://api.pokecodex.fr` (l'entrée par défaut : limite par réseau, token, puis limites des
routes coûteuses par client).

## Commandes

Bun est le gestionnaire de paquets (`bun.lock`) ; Wrangler et Vitest tournent sous Node (≥ 22,
ARM64 sur ce poste).

```sh
bun install
bun run dev            # migre la D1 locale, puis le Worker sur le port 8787 (sa D1 et son R2 locaux)
bun run ingest <tâche> # un passage dans ce Worker : species, catalog, sprites, prices ;
                       # `cards` : le catalogue ; `setup` : tout ; --remote (`setup` ne copie
                       # que le PNG des illustrations, servi tant que leur WebP n'est pas converti
                       # par `node ../conversion-illustrations-webp.mjs`, un script ponctuel hors
                       # des dépôts : docs/donnees.md)
bun run test           # les tests (worker/tests, dans le moteur de Cloudflare ; pas `bun test`,
                       # qui les lancerait hors de ce moteur)
bun run db:generate    # après une modification de worker/schema.ts, puis `bun run format` :
                       # Prettier remet en forme ses `meta/*.json`, que `bun run ci` vérifie
bun run typecheck      # tsc : le Worker et src/, puis scripts/ et les configurations
bun run lint           # ESLint, knip, puis le contrat (quand le site est à côté) : à lancer
                       # après chaque changement
bun run format         # Prettier sur src/, worker/ et scripts/ (`bun run ci` le vérifie : un
                       # oubli bloque le déploiement)
```

Le Cron ne passe pas tout seul en développement : `curl http://127.0.0.1:8787/__scheduled`.

## Principes

- **Volontairement simple** : pas d'abstraction « au cas où », pas de vérification défensive dans
  les fonctions ; on ne contrôle que ce qui vient de l'extérieur (les paramètres des routes, 422
  sinon ; le token ; les pages et fichiers des sources).
- **Le contrat** (`src/contract.ts`) : la forme de chaque réponse, et les gabarits des chemins des
  images. Le site en garde une copie (`src/types.ts`), vérifiée par `bun run lint` quand le site est
  à côté (`scripts/contracts.ts`). Une forme qui change : « élargir puis restreindre », dans les
  deux dépôts (`../pokedex/docs/deploiement.md`). `FORMAT` (`worker/snapshots.ts`, dans les ETag)
  ne vaut que pour les réponses tirées des prix et les historiques ; les espèces et le catalogue,
  gardés dans R2 tels qu'écrits, changent de forme en trois temps (même guide).
- **Anonyme** : les chemins des images ne nomment aucune source (`CardScanPath`… du contrat,
  `lib/image-paths.ts`) ; seule la table `UPSTREAMS` (`worker/ingest/sprites.ts`) connaît une
  adresse d'origine (PokéAPI ; celles des cartes, l'importateur seul). Rien de ce que rend l'API ne
  nomme une source (le site ne cite aucune source, à la demande de l'utilisateur).
- **Le schéma** : `worker/schema.ts` (D1), ses migrations écrites par Drizzle
  (`bun run db:generate` ; quand il demande si une table nouvelle en renomme une retirée, sans
  terminal pour répondre, générer en deux fois : le retrait, puis l'ajout, migrations `0004` et
  `0005`) ; une migration ajoutée ne modifie jamais les précédentes. Une migration générée qui
  reconstruit une table (`__new_…`, puis `DROP TABLE` : la plupart des changements de colonne) ne
  part jamais telle quelle : sur D1, son `PRAGMA foreign_keys=OFF` ne fait rien et
  `defer_foreign_keys` n'arrête pas les cascades ; reconstruire une table qu'une autre référence
  viderait celle-ci (`ON DELETE CASCADE`) ou échouerait. L'écrire à la main : mettre de côté les
  lignes qui en dépendent, reconstruire, les remettre ; puis la marquer en tête
  `-- reconstruction vérifiée` (sans cette marque, son `PRAGMA foreign_keys=OFF` fait échouer
  `worker/tests/schema.test.ts`). Une table retirée l'est après celles qui la référencent
  (`0004`, testé sur une base remplie). La base de l'importateur (`CARDS`) n'est pas la nôtre :
  ni migration ici, ni écriture ; les tests en ont une copie de ce qu'on lit
  (`worker/tests/cards-schema.ts`). Les grosses réponses calculées par les tâches (espèces,
  catalogue) et les images sont dans R2.
- **Les tâches dans un Workflow** (`worker/ingest/workflow.ts`) : chaque étape (`step`) est
  rejouée telle quelle si le Workflow reprend, son résultat gardé (1 Mio au plus, sérialisable) ;
  hors des étapes, rien que de déterministe (le journal aussi s'écrit dans les étapes : hors
  d'elles, une ligne serait réécrite à chaque reprise). Une étape tient en 5 min, ou redit son
  signe de vie en route (`Alive`, noté au plus chaque minute : sans signe de vie depuis 5 min, le
  passage est tenu pour arrêté, `runs.ts`), et dans la mémoire du Worker (128 Mo : les gros
  fichiers lus en flux, `json-stream.ts` ; le détail des cartes extrait par la base,
  `json_extract`, jamais chargé entier). Deux essais d'une même étape peuvent écrire la même année
  de l'historique : chacun ne la réécrit que si l'autre n'y a pas touché (`years.ts`).
- **Les sources** : on peut lire n'importe quel site, ou contourner une protection (données
  chiffrées…), mais **toujours demander d'abord à l'utilisateur**, qui obtient l'accord du site ;
  dire précisément quoi (pages, rythme, méthode). Jamais de CAPTCHA ni de défi anti-robot
  (Cloudflare…), même avec un accord. Sources convenues : PokéAPI ; TCGdex, **seulement par
  l'importateur** `pokecodex-importer` (ce Worker lit sa base et ses images, jamais TCGdex
  lui-même) ; les fichiers publics de Cardmarket (guide des prix, liste des produits : pas de
  scraping, pas d'API). Pokécardex est abandonné (décision du propriétaire, 13 novembre 2026 : ses
  tables retirées, ses images et réponses effacées du bucket) : ne jamais réintroduire de lecture de
  Pokécardex (pages, images, historique des prix). Seulement les cartes japonaises et françaises,
  sans celles de Pokémon TCG Pocket.
- **Les rythmes** (`config/jobs.ts`) : `species` chaque mois, `catalog` chaque jour (novembre
  2026 : il ne lit que la base de l'importateur), `prices` toutes les 6 h (le Cron) ; `sprites` à
  la demande seulement (`bun run ingest sprites`, et `setup`), jamais lancée par le Cron.
- **Aucune sauvegarde** (décision de l'utilisateur, octobre 2026) : ni copie de la base, ni tâche
  `backups`, ni procédure de restauration ; seul l'historique de 30 jours que Cloudflare garde de
  lui-même (D1 Time Travel). Ne pas en réintroduire sans demande.
- **Aucun prix inventé** : une carte sans prix ce jour n'en a pas ; jamais celui d'une autre carte.
  Le prix suivi (`guidePrice`, octobre 2026) : la tendance pour une carte d'une série sortie depuis
  moins de 31 jours (d'après le miroir du catalogue), sa moyenne ensuite.
- Tests (`worker/tests`, dans le moteur de Cloudflare, une D1 et un R2 par fichier, partagés par
  ses tests : chacun pose ce qu'il lit, sans compter sur l'ordre ; `helpers.ts`, leurs aides
  communes) : seulement ce où une erreur coûte (prix d'une carte, écriture de l'historique,
  irremplaçable ; liste de souhaits, une mauvaise ligne achèterait une autre carte ; catalogue des
  deux langues d'après des lignes de l'importateur, `cards-schema.ts` : type, rareté, id
  Cardmarket, image, séries écartées ; passages des tâches ; accès par token et état des tâches ;
  images : un chemin français ne mène qu'à une image française, `md` à la petite image ou à la
  grande ; migrations : une reconstruction de table effacerait en cascade, un retrait dans le
  mauvais ordre échouerait, `schema.test.ts`). Jamais le réseau : `fetch` remplacé, et
  `env.INGEST.create`. Deux R2 distincts dans les tests (`vitest.config.ts`) : en local,
  Miniflare range un bucket par son nom, et `FILES` et `IMPORTS` ont le même.
- Textes en français. Prettier : pas de point-virgule, guillemets simples, 100 colonnes.

## Architecture

| Fichier | Rôle |
|---|---|
| `worker/index.ts`, `worker/app.ts` | Les deux entrées du Worker (Internet, le site) et son Cron ; l'API sous `/v1`, 404 et 500 sans corps |
| `worker/auth.ts` | Les clients de l'entrée d'Internet (`API_TOKENS`), le token comparé à temps constant, 401 au journal ; un token envoyé en http, 403 |
| `worker/limits.ts` | Les limites de l'entrée d'Internet (`ratelimits` de `wrangler.jsonc`) : par réseau (/64 en IPv6), puis les routes coûteuses par client ; 429 |
| `worker/status.ts` | `/v1/status` (chaque tâche : libellé, état) et `/v1/health` |
| `worker/reference.ts` | Espèces, catalogue, prix, historiques, liste de souhaits (toujours `null` : `docs/donnees.md`) ; ETag des réponses tirées des prix (`pricesAnswer`) |
| `worker/images.ts` | Les images, depuis R2 (les cartes et les logos : `IMPORTS` ; les Pokémon : `FILES`), seulement un chemin de la forme exacte de son gabarit ; 404 pour une image absente |
| `worker/snapshots.ts`, `worker/history.ts` | Les grosses réponses (R2), `serveTagged` et `FORMAT` ; l'historique de plusieurs cartes en une requête |
| `worker/schema.ts`, `worker/migrations` | La D1 (Drizzle) : prix, historique, produits, miroir du catalogue (`catalog_cards`), passages |
| `worker/journal.ts` | Le journal du Worker, une ligne par évènement |
| `worker/ingest/workflow.ts`, `scripts/ingest.ts` | Le Workflow `ingest` (un passage d'une ou plusieurs tâches, par étapes) ; `bun run ingest` le lance |
| `worker/ingest/runs.ts`, `worker/ingest/sources.ts` | Les passages des tâches (`runs`) : une tâche à la fois, un signe de vie par étape (et chaque minute des longues), le rythme du Cron (`isDue`) ; le dernier passage de chaque source |
| `worker/ingest/species.ts`, `catalog.ts`, `sprites.ts`, `prices.ts` | Les quatre tâches ; le catalogue d'après la base de l'importateur ; la copie des images des Pokémon (`UPSTREAMS`) |
| `worker/ingest/years.ts`, `json-stream.ts` | L'écriture de l'historique, année par année, sans rien effacer ; les gros fichiers JSON lus en flux |
| `worker/ingest/net.ts` | Requêtes identifiées, 5 Mo au plus, sans redirection |
| `src/lib/history.ts`, `src/lib/image-paths.ts` | L'historique par année et les chemins des images (et l'`ImageKey` d'une clé de l'importateur), communs aux tâches et à l'API |
| `src/contract.ts`, `src/config/*` | Le contrat ; les tâches, le catalogue (types, raretés, versions, séries écartées), le Pokédex |
| `scripts/contracts.ts` | Le contrôle du contrat (`bun run lint`), par le site quand il est à côté |

Le détail de chaque domaine : `docs/donnees.md` (à lire avant d'y toucher, et à tenir à jour).
Mise en ligne : le Worker `pokedex-data`, déployé par Workers Builds à chaque push sur `main`
(`bun run ci`, puis `bun run deploy`) ; le guide : `../pokedex/docs/deploiement.md`.
