# CLAUDE.md

L'API privée des données du Pokédex de cartes Pokémon japonaises et françaises (le site : le dépôt
`pokedex`, à côté) : espèces (PokéAPI), catalogue et images des cartes japonaises et françaises
(Pokécardex), prix Cardmarket et leur historique. Tout tient dans un **Worker** (`worker/`,
Cloudflare Workers : Hono, D1 par son schéma Drizzle, R2) : l'API, et les **tâches d'ingestion**
(`worker/ingest/`), un Workflow par passage, les tâches à rythme lancées par un Cron toutes les
heures. Mise en ligne seulement à la fin du développement. Deux entrées : le site, par sa liaison
de service (`SiteEntrypoint`, ni token ni limite) ; ses autres clients, chacun son token, par
`https://api.pokecodex.fr` (l'entrée par défaut : limites par adresse, puis token).

## Commandes

Bun est le gestionnaire de paquets (`bun.lock`) ; Wrangler et Vitest tournent sous Node (≥ 22,
ARM64 sur ce poste).

```sh
bun install
bun run dev            # migre la D1 locale, puis le Worker sur le port 8787 (sa D1 et son R2 locaux)
bun run ingest <tâche> # un passage dans ce Worker : species, catalog, images, prices, history ;
                       # `cards` : les trois à la demande ; `setup` : tout ; --refresh, --remote
bun run test           # les tests (worker/tests, dans le moteur de Cloudflare)
bun run db:generate    # après une modification de worker/schema.ts
bun run typecheck      # tsc
bun run lint           # ESLint, puis knip : à lancer après chaque changement
bun run format         # Prettier sur src/, worker/ et scripts/
```

Le Cron ne passe pas tout seul en développement : `curl http://127.0.0.1:8787/__scheduled`.

## Principes

- **Volontairement simple** : pas d'abstraction « au cas où », pas de vérification défensive dans
  les fonctions ; on ne contrôle que ce qui vient de l'extérieur (les paramètres des routes, 422
  sinon ; le token ; les pages et fichiers des sources).
- **Le contrat** (`src/contract.ts`) : la forme de chaque réponse. Le site en garde une copie
  (`src/types.ts`) : une réponse qui change de forme change `FORMAT` (`worker/snapshots.ts`, dans
  ses ETag), et la copie du site avec elle.
- **Anonyme** : les chemins des images ne nomment aucune source (`cardScan`…,
  `lib/image-paths.ts`) ; seule la table `UPSTREAMS` (`worker/ingest/images.ts`) connaît leurs
  adresses d'origine. Rien de ce que rend l'API ne nomme une source (le site ne cite aucune
  source, à la demande de l'utilisateur).
- **Le schéma** : `worker/schema.ts` (D1), ses migrations écrites par Drizzle
  (`bun run db:generate`) ; une migration ajoutée ne modifie jamais les précédentes. Les grosses
  réponses calculées par les tâches (espèces, catalogue) et les images sont dans R2.
- **Les tâches dans un Workflow** (`worker/ingest/workflow.ts`) : chaque étape (`step`) est
  rejouée telle quelle si le Workflow reprend, son résultat gardé (1 Mio au plus, sérialisable) ;
  hors des étapes, rien que de déterministe. Une étape tient en 5 min (sans signe de vie au-delà,
  le passage est tenu pour arrêté : `runs.ts`) et dans la mémoire du Worker (128 Mo : les gros
  fichiers lus en flux, `json-stream.ts`). Deux tâches peuvent écrire la même année de
  l'historique : chacune ne la réécrit que si l'autre n'y a pas touché (`years.ts`).
- **Les sources** : on peut lire n'importe quel site, ou contourner une protection (données
  chiffrées…), mais **toujours demander d'abord à l'utilisateur**, qui obtient l'accord du site ;
  dire précisément quoi (pages, rythme, méthode). Jamais de CAPTCHA ni de défi anti-robot
  (Cloudflare…), même avec un accord. Sources convenues : PokéAPI ; Pokécardex (pages, images, et
  l'historique des prix de ses pages de cartes : accord d'octobre 2026, ses images **hébergées
  chez nous**, jamais affichées depuis ses serveurs ; ses pages chiffrées déchiffrées comme son
  propre JavaScript, avec sa clé relue dans ce JavaScript) ; les fichiers publics de Cardmarket
  (guide des prix, liste des produits : pas de scraping, pas d'API). Seulement les cartes
  japonaises et françaises.
- **Les rythmes** (`config/jobs.ts`, décision de l'utilisateur, octobre 2026) : `species` chaque
  mois, `prices` toutes les 6 h (le Cron) ; `catalog`, `images` et `history` à la demande
  seulement (`bun run ingest cards`), jamais lancées par le Cron.
- **Aucune sauvegarde** (décision de l'utilisateur, octobre 2026) : ni copie de la base, ni tâche
  `backups`, ni procédure de restauration. Ne pas en réintroduire sans demande.
- **Aucun prix inventé** : une carte sans prix ce jour n'en a pas ; jamais celui d'une autre carte.
  Le prix suivi : la règle de Pokécardex (`guidePrice`), la même pour l'historique repris.
- Tests (`worker/tests`, dans le moteur de Cloudflare, une D1 et un R2 par fichier, partagés par
  ses tests) : seulement ce où une erreur coûte (prix d'une carte, écriture de l'historique,
  irremplaçable ; lignes de la liste de souhaits, une mauvaise version achèterait une autre carte ;
  catalogue des deux langues ; passages des tâches ; accès par token et état des tâches ; images :
  un chemin français ne mène qu'à une image française). Jamais le réseau : `fetch` remplacé.
- Textes en français. Prettier : pas de point-virgule, guillemets simples, 100 colonnes.

## Architecture

| Fichier | Rôle |
|---|---|
| `worker/index.ts`, `worker/app.ts` | Les deux entrées du Worker (Internet, le site) et son Cron ; l'API sous `/v1`, 404 et 500 sans corps |
| `worker/auth.ts` | Les clients de l'entrée d'Internet (`API_TOKENS`), le token comparé à temps constant, 401 au journal |
| `worker/limits.ts` | Les limites par adresse de l'entrée d'Internet (`ratelimits` de `wrangler.jsonc`), 429 |
| `worker/status.ts` | `/v1/status` (chaque tâche : rythme, état) et `/v1/health` |
| `worker/reference.ts` | Espèces, catalogue, prix, historiques, liste de souhaits ; ETag des réponses tirées des prix (`pricesAnswer`) |
| `worker/images.ts` | Les images, depuis R2, seulement un chemin plausible ; 404 pour une image absente |
| `worker/snapshots.ts`, `worker/history.ts` | Les grosses réponses (R2), `serveTagged` et `FORMAT` ; l'historique de plusieurs cartes en une requête |
| `worker/schema.ts`, `worker/migrations` | La D1 (Drizzle) |
| `worker/journal.ts` | Le journal du Worker, une ligne par évènement |
| `worker/ingest/workflow.ts`, `scripts/ingest.ts` | Le Workflow `ingest` (un passage d'une ou plusieurs tâches, par étapes) ; `bun run ingest` le lance |
| `worker/ingest/runs.ts`, `worker/ingest/sources.ts` | Les passages des tâches (`runs`) : une tâche à la fois, un signe de vie par étape, le rythme du Cron (`isDue`) ; le dernier passage de chaque source |
| `worker/ingest/species.ts`, `catalog.ts`, `images.ts`, `prices.ts`, `history.ts` | Les cinq tâches ; la copie des images (`UPSTREAMS`) |
| `worker/ingest/years.ts`, `json-stream.ts` | L'écriture de l'historique, année par année, sans rien effacer ; les gros fichiers JSON lus en flux |
| `worker/ingest/net.ts`, `worker/ingest/pokecardex.ts` | Requêtes identifiées ; les pages de Pokécardex, déchiffrées, une toutes les 3 s |
| `src/lib/wants.ts`, `src/lib/history.ts`, `src/lib/image-paths.ts` | Communs aux tâches et à l'API : la ligne d'une carte pour la liste de souhaits ; l'historique par année ; les chemins des images |
| `src/contract.ts`, `src/config/*` | Le contrat ; les tâches, les types de cartes, le Pokédex |

Le détail de chaque domaine : `docs/donnees.md` (à lire avant d'y toucher, et à tenir à jour).
Déploiement : le README décrit l'ancien VPS, périmé (Cloudflare Workers à la fin du
développement ; **jamais `docker compose down -v`** tant qu'il tourne).
