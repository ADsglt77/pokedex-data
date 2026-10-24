# CLAUDE.md

L'API privée des données du Pokédex de cartes Pokémon japonaises et françaises (le site : le dépôt
`pokedex`, à côté) : espèces (PokéAPI), catalogue et images des cartes japonaises et françaises
(Pokécardex), prix Cardmarket et leur historique. Bun, Elysia, SQLite. Tout est privé : chaque
route exige un token (`src/auth.ts`), sauf `/v1/health`. Le site est son seul client : son nginx et
son serveur la joignent avec leur token, le navigateur ne la voit jamais.

## Commandes

Bun est le gestionnaire de paquets (`bun.lock`).

```sh
bun install
bun run dev            # l'API sur le port 3001, `.env` : API_TOKENS
bun run setup          # première installation : espèces, catalogue, prix, images, historique
bun run ingest <tâche> # species, catalog, images, prices, history, backups ; `cards` : les trois à la demande
bun test               # tests de tests/, relancés par le build Docker
bun run typecheck      # tsc
bun run lint           # ESLint, puis knip : à lancer après chaque changement
bun run format         # Prettier sur src/ et tests/
```

## Principes

- **Volontairement simple** : pas d'abstraction « au cas où », pas de vérification défensive dans
  les fonctions ; on ne contrôle que ce qui vient de l'extérieur (les paramètres des routes, par
  leurs schémas ; le token ; les pages et fichiers des sources).
- **Le contrat** (`src/contract.ts`) : la forme de chaque réponse. Le site en garde une copie
  (`src/types.ts`) : une réponse qui change de forme change `FORMAT` (`src/snapshots.ts`, dans ses
  ETag), et la copie du site avec elle.
- **Anonyme** : les chemins des images ne nomment aucune source (`cardScan`…, `images.ts`) ; seule
  la table `UPSTREAMS`, à côté, connaît leurs adresses d'origine. Rien de ce que rend l'API ne nomme
  une source (le site ne cite aucune source, à la demande de l'utilisateur).
- **Le schéma** (`db.ts`) : `DATA_STEPS` repris du Pokédex à l'octet près (l'empreinte de chaque
  étape, `schema_steps`) ; une étape ajoutée ne modifie jamais les précédentes.
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
  mois, `prices` toutes les 6 h, `backups` chaque jour ; `catalog`, `images` et `history` à la
  demande seulement (`bun run ingest cards`), jamais dans la boucle.
- **Aucun prix inventé** : une carte sans prix ce jour n'en a pas ; jamais celui d'une autre carte.
  Le prix suivi : la règle de Pokécardex (`guidePrice`), la même pour l'historique repris.
- Tests (`tests/`) : seulement ce où une erreur coûte (prix d'une carte, écriture de l'historique,
  irremplaçable ; lignes de la liste de souhaits, une mauvaise version achèterait une autre carte ;
  étapes du schéma ; accès par token et état des tâches ; images : un chemin français ne mène
  qu'à une image française). Le build Docker les lance.
- Textes en français. Prettier : pas de point-virgule, guillemets simples, 100 colonnes.

## Architecture (`src/`)

| Fichier | Rôle |
|---|---|
| `index.ts`, `app.ts` | Lance l'API ; ses routes sous `/v1`, la garde du token avant toute route, 404 et 500 sans corps |
| `auth.ts` | Les clients (`API_TOKENS`), le token comparé à temps constant, 401 au journal |
| `status.ts` | `/v1/status` (chaque tâche : rythme, état, dates) et `/v1/health` |
| `reference.ts` | Espèces, catalogue, prix, historiques, liste de souhaits ; ETag des réponses tirées des prix (`pricesTag`) |
| `images.ts` | Les images copiées d'avance (`IMAGES_DIR`), leurs chemins neutres (français : `fr/`), leurs adresses d'origine (`UPSTREAMS`) ; 404 pour une image absente, jamais de copie à la demande |
| `snapshots.ts` | Les grosses réponses, calculées en fin de tâche, gardées en gzip ; `serveTagged` et la forme des réponses (`FORMAT`) |
| `history.ts` | L'historique des prix, une ligne par carte et par année |
| `db.ts` | `data.db` dans `DATA_DIR`, schéma par étapes |
| `journal.ts` | Le journal, une ligne par évènement |
| `ingest.ts`, `jobs/*` | Les tâches d'ingestion, une à la demande, `cards`, ou `--loop` |
| `runs.ts` | Les passages des tâches (`runs`) : une tâche à la fois (`catalog` et `history` : l'une ou l'autre), un signe de vie chaque minute |
| `lib/net.ts`, `lib/pokecardex.ts` | Requêtes identifiées et cache de PokéAPI ; les pages de Pokécardex, déchiffrées, une toutes les 3 s |
| `lib/wants.ts` | La ligne d'une carte pour la liste de souhaits |
| `contract.ts`, `config/*` | Le contrat ; les tâches, les types de cartes, le Pokédex |

Le détail de chaque domaine : `docs/donnees.md` (à lire avant d'y toucher, et à tenir à jour).
Déploiement : README (même VPS que le site, réseau Docker `pokedex-net`, aucun port publié ;
**jamais `docker compose down -v`**).
