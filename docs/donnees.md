# Les données

Ce que lit chaque tâche d'ingestion, ce qu'elle range dans `data.db` et ce qu'en rend l'API. À
lire avant de toucher à ce domaine (les règles : `CLAUDE.md`).

## Espèces (`jobs/species.ts`, chaque mois)

Les 1 025 espèces d'après PokéAPI (nom français, anglais et japonais, types, génération ;
catégorie, description, taille, poids…), lues par `lib/net.ts` (cache disque d'un mois, requêtes
identifiées) : `/v1/species` et `/v1/species/details`. Une espèce sans nom français ou anglais, ou
d'un type inconnu (une nouvelle génération pas encore traduite), fait échouer la tâche : les
espèces d'avant restent. Une nouvelle génération s'ajoute dans `GENERATIONS` (`config/pokedex.ts`).

## Catalogue (`jobs/catalog.ts`, à la demande)

Les cartes japonaises de Pokécardex, Pokémon, dresseurs et énergies (`lib/pokecardex.ts`), environ
450 séries de 1996 à aujourd'hui, decks, promos et anciennes séries compris, sans les
exclusivités d'autres pays d'Asie (bloc « Asia Exclusive » de son menu, `asiaExclusive`) → tables
`sets`, `cards`, `card_species`, `rarities`.

- La liste des séries vient de son plan du site (`sitemap_fr.xml`, `/series/jp/<code>`) ; chaque
  série, de sa page : son nom, sa sortie au Japon, et ses cartes (id Pokécardex, numéro imprimé
  « 001/165 », `sort`, noms français, anglais et allemand, Pokémon, id Cardmarket, rareté, type,
  illustrateur, versions ; un tiret seul, « — », qu'il écrit pour « inconnu », est gardé vide),
  les raretés (nom, ordre) et le menu des séries (le bloc de chacune, son rang, si c'est un deck).
- Ses pages portent leurs données chiffrées (`__INITIAL_DATA_ENCRYPTED__`, AES-CBC) : déchiffrées
  avec la clé que contient son JavaScript, relue quand l'adresse de son script change, jamais
  recopiée dans le dépôt. Une page toutes les 3 s, User-Agent identifié : le premier passage prend
  une vingtaine de minutes ; ensuite, une série est relue après une semaine, après un jour si elle
  est sortie depuis moins de 90 jours (`read_at`), et `--refresh` les relit toutes.
- Les gardes : une page en échec n'empêche pas les autres (la tâche échoue ensuite) ; dix
  d'affilée arrêtent la lecture (le site a changé) ; une série qui donne moins de la moitié des
  cartes qu'elle avait est refusée ; une page sans cartes ne retire rien (plus de la moitié des
  séries connues sans cartes : la tâche échoue) ; une carte qu'une lecture de sa série ne voit plus
  est retirée. Tant qu'aucune carte n'a été lue, les réponses du catalogue répondent 404.
- Les réponses, recalculées au début et en fin de tâche (`saveCatalog`, `snapshots.ts` : gardées en
  gzip, une réponse inchangée n'est pas recompressée) :
  - `/v1/catalog/species/<n°>` : les cartes Pokémon d'un Pokémon (une réponse pour chacun des
    1 025, même sans carte), des plus récentes aux plus anciennes : `[série, numéro (sans numéro
    imprimé : sort), id Cardmarket (0 : aucun), nom français, numéro de son image (0 : aucune),
    rareté (0 : inconnue), type (0 : inconnu), Pokémon s'ils sont plusieurs]` ; chaque série
    `[nom, sortie, logo]` ; les raretés `[nom, rang]` ;
  - `/v1/catalog/sets` : les séries, des plus récentes aux plus anciennes, `[code, nom, sortie,
    logo, nombre de cartes, rang de son bloc (-1 : aucun), 1 pour un deck]`, et les blocs ;
  - `/v1/catalog/sets/<code>` : toutes les cartes d'une série dans son ordre, `{ number, printed,
    name, en, de, dexIds, cardmarket, image, rarity, type, illustrator, versions }`, et leurs
    raretés.
- Les types sont numérotés par Pokécardex sans être nommés (`CARD_TYPES`, `config/catalog.ts` ; le
  site a leurs noms). Les raretés gardent les noms de Pokécardex (« C », « SAR »…, « Commune »,
  « Holographique » pour les anciennes, « Sans rareté »).

## Images (`images.ts`, `jobs/images.ts`, à la demande)

Copiées chez nous (`IMAGES_DIR`), condition de Pokécardex ; servies à `/v1/images/…`, gardées un
an par les clients (`immutable` : `mirror` ne réécrit jamais un fichier qui existe). Les chemins
sont neutres (`cardScan`…, `images.ts`) ; leur adresse d'origine n'est que dans `UPSTREAMS` :

| Chemin | Origine |
|---|---|
| `/images/cards/<série>/<sort>-<md\|hd>.webp` | Le scan d'une carte (`md` pour les grilles, `hd` pour la fiche), Pokécardex |
| `/images/sets/<série>-<md\|hd>.webp` | Le logo japonais d'une série (`logos_jp`, jamais le français) |
| `/images/types/<n>.webp`, `/images/rarities/<n>.webp` | Les icônes des types et des raretés |
| `/images/species/<n>.png`, `/images/species/artwork/<n>.png` | Le sprite et l'illustration d'un Pokémon, PokéAPI |

- La tâche, deux téléchargements à la fois, seulement ce qui manque (environ 1,5 Go la première
  fois) : les logos de chaque série du catalogue, notés s'ils existent (`sets.logo`, cherché de
  nouveau chaque semaine), les icônes, les sprites et illustrations des 1 025 Pokémon, puis le scan
  de chaque carte en deux tailles, noté s'il existe (`cards.image` : le catalogue le dit
  d'avance ; une carte sans scan est recherchée chaque semaine). Une image en erreur n'arrête pas
  les autres : rien n'est noté pour elle, la tâche échoue à la fin (à la 20e erreur, elle
  s'arrête : la source est sans doute en panne). En fin de tâche, le catalogue est recalculé.
- La copie à la demande (`serveImage`) : une image absente (une référence saisie hors du
  catalogue, une image pas encore copiée) est copiée quand on la demande, seulement pour un chemin
  connu et plausible (une série du catalogue et un numéro jusqu'au plus grand des siens, le logo
  d'une série du catalogue, un type de `CARD_TYPES`, une rareté connue, un Pokémon de 1 à 1 025) ;
  4 copies à la fois, 15 s au plus ; une absence retenue une semaine ; une source en panne : 502,
  et « Image non copiée » au journal. Écrite d'un coup (un fichier provisoire, retiré si
  l'écriture échoue).

## Prix (`jobs/prices.ts`, toutes les 6 h)

Le guide des prix public de Cardmarket et sa liste des produits (`products_singles_6.json`),
seulement les cartes à l'unité (catégorie 51) :

- `cardmarket_products` : le nom de chaque produit, son extension (`idExpansion`) et sa carte
  (`idMetacard`), pour la liste de souhaits ; vides pour un produit sorti de la liste.
- `cardmarket_prices` : le prix du jour de chaque carte, son plus bas et son prix d'il y a 30 jours
  (`month_ago`, d'après l'historique, une semaine plus tôt au plus : `priceBefore`).
- `cardmarket_history` (`history.ts`) : l'historique, irremplaçable (Cardmarket n'en garde pas),
  une ligne par carte et par année, à partir de son premier jour avec un prix.
- **Le prix suivi, partout le même** (décision de l'utilisateur, octobre 2026) : la règle de
  Pokécardex (`guidePrice`, testée), la tendance Cardmarket pour une carte d'une série sortie depuis
  moins de 31 jours (d'après le catalogue), sa moyenne sur 30 jours ensuite, à défaut sur 7 jours,
  puis sur 1 jour (jamais la tendance d'une carte ancienne à sa place). Vérifié : pour une même
  carte un même jour, la valeur de Pokécardex.
- Les gardes : relancée le même jour, la tâche remplace le prix du jour ; moins de la moitié des
  prix d'avant (le format du guide a changé), rien n'est écrit et la tâche échoue. L'écriture,
  séparée du téléchargement (`savePriceGuide`), est testée. Rien n'est retéléchargé (29 Mo) tant
  que le guide n'a pas changé (`sources` : son `Last-Modified`).
- Les réponses : `/v1/prices?ids=…` (`readPrices` : le jour, et une clé par carte demandée,
  `[prix, plus bas, prix d'il y a 30 jours]` ou `null` sans prix ; 404 tant que le guide n'a
  jamais été lu) ; `/v1/prices/<id>` (l'historique d'une carte) et `/v1/histories?ids=…` (ceux de
  plusieurs, une clé par id, `null` sans historique). Les ids : des entiers de 1 à 9 chiffres sans
  zéro devant, 1 025 au plus (422 sinon). Leur ETag est tiré du passage de la tâche `prices` et de
  l'avancée de la tâche `history` (`pricesTag`, lu dans la même transaction que la réponse) : 304
  tant que rien n'a changé.

## Historique repris (`jobs/history.ts`, à la demande)

Accord de Pokécardex, octobre 2026 : il relève le guide chaque jour, et la page de chacune de ses
cartes (`/carte/jp/<id>`) porte ses prix des **180 derniers jours** au plus, presque jour par jour.
Pour chaque carte du catalogue avec un id Cardmarket (environ 28 000), une fois : la série de la
carte elle-même (`mainHistory`, testé : son produit Cardmarket, celui du catalogue, sans variante
« Reverse » ni version, au prix suivi « avg30 », la même règle que `prices`), et chaque jour avant
le dernier relevé prend son prix (`mergePrices`, testé : celui-là et les suivants restent ceux du
relevé). Une page toutes les 3 s : environ 23 h la première fois ; les séries les plus récentes
d'abord ; chaque carte lue une fois (`history_imports`), un passage suivant ne lit que les
nouvelles ; 10 pages en échec d'affilée arrêtent la lecture ; des cartes en échec font échouer la
tâche (relues au passage suivant). Le prix d'il y a 30 jours de chaque carte reprise suit, et
l'avancée est notée (`sources` : `history`, toutes les 100 cartes), que suit l'ETag des prix.

## Liste de souhaits (`/v1/wants?ids=…`, `lib/wants.ts`)

Pour chaque id Cardmarket demandé, sa ligne pour « Ajouter une deck list » de la liste de souhaits
de Cardmarket, ou `null` quand aucune ne désignerait sûrement cette carte-là (une mauvaise version
achèterait une autre carte ; règles pures `wantsLine` et `wantsVersion`, et le SQL qui en réunit
les données : `tests/wants.test.ts`). Le format, vérifié par l'utilisateur sur cardmarket.com
(octobre 2026) : `1x <nom du produit, sans crochets, « | » devenu une espace> (V.<n>) (<extension>)`.
Le produit 719621 donne `1x Charmander Blazing Destruction Steady Firebreathing (V.2) (Pokémon Card
151)`, que Cardmarket ajoute comme « Salamèche (sv2a 168) ». Toujours `1x`.

- La version : sans `(V.n)`, Cardmarket prend la V.1. Elle est écrite dès que le groupe du produit
  (même extension et même carte : `expansion`, `metacard`) en compte deux ou plus. Cardmarket
  numérote les versions dans l'ordre de leur **numéro imprimé**, pas de leur création ni de leurs
  ids (vérifié : Toxtricity VMAX S2 037 est la V.1, S2 107 la V.2 ; sv2a 004 la V.1, sv2a 168 la
  V.2). Ce numéro vient du catalogue ; la version n'est donnée que si chaque produit du groupe y a
  exactement un numéro, fait de chiffres seulement, jamais deux fois le même. Sinon, pas de ligne.
- L'extension : ses noms ne sont dans aucun fichier public de Cardmarket ; ceux des séries du
  catalogue leur correspondent. Un seul nom de série pour l'extension (sans les espaces des bords),
  porté par aucune autre extension ; sinon, pas de ligne (Cardmarket ajouterait « toutes
  versions »).
- Pas de ligne non plus pour un produit inconnu, sans extension ou sans métacarte, ni pour une
  parenthèse dans le nom ou l'extension. Ni la langue ni l'état ne tiennent dans une ligne.
- Calculée à chaque demande (`Cache-Control: no-cache`), requêtes préparées une fois, chaque id et
  chaque extension une fois par demande : 1 025 ids en moins de 0,1 s.

## État des tâches (`status.ts`)

`runs` note chaque passage (`runs.ts`, `ingest.ts`) : son début, sa fin, s'il a réussi, et la
cause d'un échec (`message` : celui de l'erreur, ou « interrompue » pour un passage arrêté).
Pendant qu'il tourne, il donne signe de vie chaque minute (`alive_at`) : une tâche n'est pas lancée
deux fois à la fois (deux processus doubleraient le rythme des requêtes), mais un passage sans
signe de vie depuis 5 min a été arrêté net (conteneur tué, mémoire épuisée, machine redémarrée) :
il ne bloque plus sa tâche, et il est noté interrompu à son passage suivant (testé).

`/v1/status` rend seulement le nom, le libellé et l'état de chaque tâche, dans l'ordre
d'`INGEST_JOBS`. Les détails de calcul restent internes à l'API. Un passage en cours ne compte pas
encore : l'état reste celui du passage d'avant. Les états : `never` (tâche à la demande jamais
passée), `failed` (le dernier passage, ou un passage arrêté net ; sa cause n'est pas rendue : elle
est dans `runs.message` et dans la sortie de l'ingestion, le journal du service `ingest` ou celui
du conteneur d'une tâche à la demande), `late` (deux intervalles sans réussite ; jamais pour une
tâche à la demande), `frozen` (les prix : le guide inchangé depuis plus de deux jours, chaque jour
perdu manque pour toujours à l'historique), `ok`. `/v1/health`, sans token : 503 si une tâche à
rythme est en retard ou les prix figés.
