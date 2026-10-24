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

Les cartes japonaises, puis les françaises, de Pokécardex, Pokémon, dresseurs et énergies
(`lib/pokecardex.ts`) : environ 450 séries japonaises de 1996 à aujourd'hui, decks, promos et
anciennes séries compris, sans les exclusivités d'autres pays d'Asie (bloc « Asia Exclusive » de
son menu japonais, `asiaExclusive`), et ses 249 séries françaises (sa zone française : section
suivante) → tables `sets`, `cards`, `card_species`, `rarities`. Les ids des cartes et des raretés
et les codes des séries se répètent d'une zone à l'autre (la carte 7091, la série SVP, la rareté
48) : chaque ligne a sa langue (`lang`, `ja` ou `fr`, dans les clés), chaque langue ses réponses.

- La liste des séries vient de son plan du site (`sitemap_fr.xml` : `/series/jp/<code>` au Japon,
  `/series/<code>` en France ; seulement les codes de majuscules, chiffres, `_` et `-`, que
  permettent les chemins des images : `seriesIn`, testé), lue pour les deux langues avant toute
  série ; chaque série, de sa
  page : son nom, sa sortie (au Japon ; en France pour une française), et ses cartes (id
  Pokécardex, numéro imprimé « 001/165 », `sort`, noms français, anglais et allemand, Pokémon, id
  Cardmarket, rareté, type, illustrateur, versions ; un tiret seul, « — », qu'il écrit pour
  « inconnu », est gardé vide), les raretés de sa zone (nom, ordre ; les françaises ne sont pas
  les japonaises sous les mêmes ids) et le menu des séries de sa langue (le bloc de chacune, son
  rang, si c'est un deck ; le menu français n'a pas de decks : ses decks et kits sont des séries
  du bloc « Kit du Dresseur »). En français, les cartes qui n'existent qu'en anglais
  (`only_english`) sont écartées ; le type 17 (Double Colorless Energy, hors de `CARD_TYPES`) est
  gardé tel quel, comme tout type (le site traite un type inconnu comme aucun).
- Le nom de l'extension de chaque série chez Cardmarket (`sets.expansion_name`, pour la liste de
  souhaits) : pour une japonaise, son nom (ceux de Pokécardex sont ceux de Cardmarket) ; pour une
  française, son nom anglais, lu dans le menu d'**une seule page anglaise par passage**
  (`/en/series/<code>` de la première série française à relire, sinon des suivantes, trois au
  plus ; `readEnglishSeriesNames`), gardé seulement si les adresses Cardmarket de ses cartes
  (`cardmarket_url`) commencent toutes par lui, écrit comme Cardmarket l'écrit (`expansionNameOf`,
  `cardmarketSlug` : sans accents ni apostrophes, un tiret pour chaque suite de signes) ; sinon
  aucun (`''` : pas de ligne). Sans nom anglais pour une série (aucune des trois pages ne donne les
  noms, illisible ou son menu changé ; ou la série absente du menu) : elle garde le nom qu'un
  passage d'avant a confirmé, tant que ses cartes le confirment encore (sinon aucun) ; le journal
  le dit, et la tâche n'échoue pas pour autant.
- Ses pages portent leurs données chiffrées (`__INITIAL_DATA_ENCRYPTED__`, AES-CBC) : déchiffrées
  avec la clé que contient son JavaScript, relue quand l'adresse de son script change, jamais
  recopiée dans le dépôt. Une page toutes les 3 s, User-Agent identifié : le premier passage prend
  une vingtaine de minutes pour les japonaises (« Séries japonaises »), une douzaine pour les
  françaises (« Séries françaises ») ; ensuite, une série est relue après une semaine, après un
  jour si elle est sortie depuis moins de 90 jours (`read_at`), et `--refresh` les relit toutes.
- Les gardes : une page en échec n'empêche pas les autres (la tâche échoue ensuite) ; dix
  d'affilée arrêtent la lecture, celle de l'autre langue comprise (le site a changé) ; une série
  qui donne moins de la moitié des cartes qu'elle avait est refusée ; une page sans cartes ne
  retire rien (plus de la moitié des séries connues sans cartes : la tâche échoue) ; une carte
  qu'une lecture de sa série ne voit plus est retirée. Tant qu'aucune carte d'une langue n'a été
  lue, les réponses de cette langue répondent 404.
- Les réponses, recalculées au début et en fin de tâche, chaque langue d'après ses seules lignes
  (`saveCatalog`, `snapshots.ts` : gardées en gzip, une réponse inchangée n'est pas recompressée ;
  `snapshotName` : celles du japonais gardent leurs noms, `catalog/…`, celles du français, de même
  forme, sont nommées `catalog/fr/…`, la sortie y étant celle en France ; l'API sert chacune à la
  route de même nom, `/v1/catalog/…` et `/v1/catalog/fr/…`, mêmes paramètres, `reference.ts`) :
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

Copiées chez nous (`IMAGES_DIR`), condition de Pokécardex, **toutes d'avance** par la tâche
`images` ; servies à `/v1/images/…`, gardées un an par les clients (`immutable` : une image
copiée ne change pas, sauf le scan d'une carte renumérotée, plus bas). Les chemins sont neutres
(`cardScan`…, `images.ts`) ; leur adresse d'origine n'est que dans `UPSTREAMS`. Les codes des
séries et les rangs se répètent d'une langue à l'autre (SVP, rang 1) : les chemins français ont un
dossier `fr/` de plus, les japonais n'ont pas changé.

| Chemin | Origine |
|---|---|
| `/images/cards/<série>/<sort>-<md\|hd>.webp` | Le scan d'une carte japonaise (`md` pour les grilles, `hd` pour la fiche), Pokécardex (`sets_jp/`) |
| `/images/cards/fr/<série>/<sort>-<md\|hd>.webp` | Le scan d'une carte française, Pokécardex (`sets/<série>/FR/`, jamais le dossier sans langue : section suivante) |
| `/images/sets/<série>-<md\|hd>.webp`, `/images/sets/fr/<série>-<md\|hd>.webp` | Le logo d'une série, japonaise (`logos_jp`) ou française (`logos`) |
| `/images/types/<n>.webp`, `/images/rarities/<n>.webp` | Les icônes des types et des raretés, communes aux deux langues : un même id de rareté a la même icône chez la source |
| `/images/species/<n>.png`, `/images/species/artwork/<n>.png` | Le sprite et l'illustration d'un Pokémon, PokéAPI |

- La tâche, deux téléchargements à la fois, seulement ce qui manque (environ 1,5 Go la première
  fois pour les japonaises, 1 à 1,4 Go de plus pour les françaises) : les logos de chaque série du catalogue,
  dans chaque langue, notés s'ils existent (`sets.logo`, par langue ; cherché de nouveau chaque
  semaine), les icônes (les types ; les raretés qu'utilisent les cartes de l'une ou l'autre
  langue, une icône par id), les sprites et illustrations des 1 025 Pokémon, puis le scan de
  chaque carte, de chaque langue, en deux tailles, noté s'il existe (`cards.image` : le catalogue
  le dit d'avance ; une carte sans scan est recherchée chaque semaine). Chaque requête et chaque
  note portent la langue : l'id 7091 de chaque langue est une autre carte. Une image en erreur
  n'arrête pas les autres : rien n'est noté pour elle, la tâche échoue à la fin (à la 20e erreur,
  elle s'arrête : la source est sans doute en panne). En fin de tâche, le catalogue est recalculé.
- **Une série renumérotée** (testé) : le chemin d'un scan suit le rang de la carte. Quand la
  source change le rang ou la série d'une carte (une carte arrivée en tête de série décale les
  suivantes), le catalogue la remet à chercher (`cards.image` nul), et le fichier de son nouveau
  chemin est souvent le scan de la carte qui avait ce rang : la tâche recopie donc le scan de
  toute carte pas encore notée, même si son fichier existe (`mirror`, `force`), en le remplaçant
  d'un coup. Elle note une carte seulement si elle est encore à la place copiée (sa série et son
  rang : le catalogue, dans un autre processus, a pu la déplacer entre-temps ; elle reste alors à
  chercher). Les chemins ne changent pas (décision du propriétaire, octobre 2026 : aucun rang
  changé du 19 au 24 octobre) : un navigateur qui avait l'ancien scan d'un chemin le garde jusqu'à
  ce que son cache se vide (`immutable`, un an), le nginx du site jusqu'à son prochain
  déploiement, qui vide son cache. Un fichier déposé à la main pour une carte pas encore notée est
  donc recopié aussi.
- **Aucune copie à la demande** (décision du propriétaire, octobre 2026) : `serveImage` sert le
  fichier s'il existe, sinon 404 sans rien télécharger (une réponse sans cache : l'image est servie
  dès que la tâche l'a copiée) ; le site montre alors la carte de substitution. Seulement pour un
  chemin plausible (`UPSTREAMS` : une série du catalogue **de sa langue** et un numéro
  jusqu'au plus grand des siens, le logo d'une série du catalogue de sa langue, un type de
  `CARD_TYPES`, une rareté connue d'une langue ou de l'autre, un Pokémon de 1 à 1 025). Une image
  est écrite d'un coup (un fichier provisoire propre à chaque copie, deux cartes pouvant partager
  un scan, NRGY 41 au Japon ; retiré si l'écriture échoue : l'API ne sert jamais une image à
  moitié écrite).

## La zone française de Pokécardex (repérée le 22 octobre 2026)

Accord du propriétaire pour les cartes françaises comme pour les japonaises : mêmes pages, même
méthode. Repérage sur `/series/MEG` (récente) et `/series/BS` (ancienne), avec un script à part ;
`lib/pokecardex.ts` lit une série, une carte et le plan du site dans une langue (`CardLanguage`,
`ja` ou `fr` : `seriesIn`, `seriesCodes`, `readSeries`, `readCard`, `menuBlocks`). Les tâches
`catalog`, `images` et `history` lisent cette zone (sections Catalogue, Images et Historique repris).
Ce qui suit est ce que le repérage a établi.

- **Les pages** : `/series/<code>` (japonaises : `/series/jp/<code>`), chiffrées de la même façon,
  avec le même script (`/react/sets/assets/index-….js`) et sa clé : la méthode de `keyOf` et de
  `pageData` (`lib/pokecardex.ts`) déchiffre ces pages sans changement. Le document a les mêmes
  clés que celui d'une page japonaise (`currentSeries`, `seriesMenu`, `cartes`, `raretes`…) et les
  cartes les mêmes champs (`id_card`, `num_card`, `sort`, `name_card_fr/en/de`, `id_pokedex_list`,
  `id_cardmarket`, `cardmarket_url`, `id_rarete`, `id_type`, `nom_illustrateur`, `versions`,
  `only_english`…). Différences : `currentSeries.fullName` est français (« Méga-Évolution », « Set de
  base ») ; `currentSeries.releaseDateUS` est renseignée (`null` pour une série japonaise) ;
  `currentSeries.commercialName` (« ME01 ») s'y ajoute sur certaines séries récentes.
- **La liste des séries** : 249 séries françaises, les mêmes dans le menu (`seriesMenu.blocksByRegion.FR`)
  et dans le plan du site (`sitemap_fr.xml` : `/series/<code>`, sans les pages d'index `/series/jp` et
  `/series/chn`). Le menu est identique sur les trois pages lues (MEG, BS et la page japonaise SV2A) :
  toute page déjà lue le donne.
- **Le nom anglais d'une série (celui de l'extension chez Cardmarket) : aucun champ de la page
  française ne le donne.** `currentSeries` (`id`, `shortName`, `fullName` français, `releaseDateFR`,
  `releaseDateUS`, `totalCards`, `secretCards`, `checklistLink`, `checklistLinkV2`, `products`,
  `commercialName`) et les entrées du menu (`id`, `shortName`, `fullName` français, `commercialName`,
  `link`) n'en ont pas ; `nom_ext` et `nom_us` de chaque carte sont vides (`""` sur les 290 cartes
  lues). Les approches essayées ou écartées :
  - le premier segment de `cartes[].cardmarket_url` (« Mega-Evolution/Bulbasaur-V1-MEG001 ») : le
    même sur toutes les cartes d'une série (« Mega-Evolution » sur les 188 de MEG, « Base-Set » sur les
    102 de BS), le nom de l'extension avec des tirets à la place des espaces. Il perd les accents (page
    japonaise SV2A : `fullName` « Pokémon Card 151 », segment « Pokemon-Card-151 »), sans doute les
    signes comme « & », et les apostrophes (« Champion's Path » : « Champions-Path ») : il ne donne
    pas le nom, mais **confirme** celui qu'on a (`cardmarketSlug` et `expansionNameOf`,
    `lib/pokecardex.ts`, testés) ;
  - `nameUS` du bloc de la série dans le menu (« Mega Evolution ») : celui du **bloc**, donné à toutes
    ses séries (les neuf du bloc « Méga-Évolution » : « Mega Evolution »), donc l'extension seulement
    pour MEG, pas pour PFL, ASC… (dont l'extension a son nom) : écarté ;
  - **la page anglaise de la série** (`/en/series/<code>`, annoncée par le `hreflang` de la page) :
    même document, mais `currentSeries.fullName` y est le nom anglais. Lue une fois le 22 octobre
    2026 : `/en/series/MEG` donne « Mega Evolution », avec 188 cartes dont l'adresse Cardmarket
    commence par `Mega-Evolution` ; `expansionNameOf` accepte ce nom. Son menu donne aussi, **dans
    la même page**, le `fullName` anglais des 249 séries françaises
    (`seriesMenu.blocksByRegion.FR[].series[].fullName` : « Pitch Black », « Phantasmal Flames »,
    « Black Bolt »… ; 91 sont identiques au français) et des `link` vers `/en/series/<code>` : la
    tâche `catalog` lit donc une seule page anglaise par passage, au lieu de 249
    (`readEnglishSeriesNames`, `lib/pokecardex.ts`, retenu).
- **Le scan d'une carte** : `https://pokecardex-scans.b-cdn.net/sets/<série>/FR/<sort>.jpg?class=<md|hd>`
  (la fonction du script : dossier `sets/`, puis `nom_court` de la carte, c'est-à-dire le code de sa
  série, puis `FR`, puis `sort` de la carte, **non** son numéro imprimé : le 188e de MEG, « 188/132 »,
  est `188.jpg`). Pour une autre langue du site (`US`, `DE`), le script prend `US` ou `DE` à la place de
  `FR` : on garde `FR`. La classe : `md` (grilles) et `hd` (fiche) comme pour les scans japonais ;
  le script emploie aussi `sd` et `original`, non vérifiés. Sans version, ou avec la version 1
  (« Standard »), aucun dossier de plus ; pour une version d'`id_version` de 2 à 246 (`versions[]`,
  « Reverse » = 2), le script met son id avant le rang (`…/FR/<id_version>/<sort>.jpg`) et retombe sur
  l'adresse sans version si elle manque. Le dossier sans langue (`sets/<série>/<sort>.jpg`) n'est
  jamais construit par le site pour la zone française : BS y répond 200 (le fichier n'a pas la
  taille de celui de `FR`), MEG y répond 404 ; ne pas l'employer. Le logo : `logos/<série>.png` dans
  `https://pokecardex.b-cdn.net/assets/images/` (`logos_jp/` pour les japonaises). Ce sont les
  adresses que copie la tâche `images` (`UPSTREAMS`, `images.ts`, testées dans
  `tests/images.test.ts`) : le scan sans version, pas ceux des versions (`FR/<id_version>/…`).
- **Le menu** (`seriesMenu.blocksByRegion`) : `{ FR: 19 blocs, JP: 19 blocs, CHN: 5 blocs }`. Un bloc
  français : `{ id: "bloc-19-fr", name: "Méga-Évolution", nameUS: "Mega Evolution", series: [{ id,
  shortName, fullName, commercialName?, link }] }` ; `link` est `https://www.pokecardex.com/series/<shortName>`.
  Pas de `decks` (les blocs japonais en ont) : les decks et kits sont des séries du bloc « Kit du
  Dresseur ». Les séries d'un bloc vont des plus récentes aux plus anciennes (les promos et énergies
  de la même époque à la fin) ; `commercialName` (« ME05 », « EV10.5 », « EB12 », « SL11.5 », « XY12 »)
  n'existe que de XY à Méga-Évolution (69 séries sur 249). Le `name` est en français, `nameUS` en
  anglais (identique pour XY, HeartGold SoulSilver, EX, Wizards, Promos, Jumbos, World Championships,
  McDonald's). Les blocs, dans l'ordre du menu (nombre de séries) : Méga-Évolution (9), Écarlate et
  Violet (18), Épée et Bouclier (18), Soleil et Lune (16), XY (16), Noir et Blanc (13), Appel des
  légendes (1), HeartGold SoulSilver (5), Platine (4), Diamant et Perle (8), EX (17), Wizards (16) ; puis
  Promos (16), Ligue Pokémon (10), Jumbos (1), Kit du Dresseur (32), World Championships (20),
  McDonald's (15), Divers (14). **Aucun bloc n'est d'un autre pays** (pas d'équivalent de « Asia
  Exclusive » : la Chine et le Japon ont leur région). Ce qui n'est pas une série de cartes à jouer, à
  trancher (rien n'est écarté ici) : dans « Divers » (`nameUS` « Others »), `TOPPS` (« Topps »), `LMN5` et
  `LMN6` (« Lamincards »), `PWC98` et `PWC10` (« Pikachu World Collection »), `ARTAC` (« Art
  Academy ») ; les séries McDonald's dont le code finit par `US` (`MC8US`, `MC9US` : « … - USA » ;
  `MC10US`, `MC11US`) sont sans doute des promotions américaines (leurs cartes n'ont pas été lues :
  en anglais ou non ?).
- **Dans les cartes** : `sort` est unique, de 1 au nombre de cartes de la série, égal à
  `ordre_affichage` ; `num_card` : « 001/132 » (secrètes : « 188/132 ») ou « 1 » (BS), dont le total imprimé (132) est
  `total` de la carte, pas `currentSeries.totalCards` (188) ; `cardmarket_url` et `id_cardmarket`
  sont renseignés sur toutes les cartes lues ; `only_english` est à 0 sur toutes les cartes lues,
  mais vrai pour certaines **versions** (« Shadowless », « 4th print ») : leur scan français n'a pas
  été cherché. `raretes` est la liste des 21 raretés françaises (la même sur MEG et BS), pas celle
  de la série ; ses ids recoupent ceux des raretés japonaises (39 sur SV2A) sans s'y confondre :
  onze y ont le même nom, l'id 48 s'appelle « Futuriste Rare » ici et « FUR » là, et neuf (32 à 36,
  38 à 40, 43 : « Double Rare », « Illustration Rare »…) n'existent qu'ici. `id_type` : les mêmes
  numéros que les japonaises (`CARD_TYPES`), sauf le 17 sur BS (Double Colorless Energy), qui n'y
  est pas.
- **Les requêtes du repérage** (6, 3,5 s d'écart, User-Agent de `lib/net.ts`) : `GET` du script
  `/react/sets/assets/index-Ck3W_Plh.js` (200, 1,5 Mo) ; `HEAD` sur `sets/MEG/FR/1.jpg?class=md` (200,
  `image/webp`), `sets/BS/FR/1.jpg?class=md` (200), `sets/MEG/FR/1.jpg?class=hd` (200),
  `sets/MEG/FR/2/1.jpg?class=md` (200, d'une autre taille que `FR/1.jpg`), `sets/MEG/FR/188.jpg?class=md`
  (200). Les pages `/series/MEG`, `/series/BS` et `/series/jp/SV2A`, et le plan du site, avaient été
  enregistrés plus tôt le même jour par un premier relevé (avec trois `HEAD` : `sets/MEG/1.jpg` 404,
  `sets/BS/1.jpg` 200, `logos/MEG.png` 200). La page anglaise `/en/series/MEG` (200, 377 Ko, même
  script `index-Ck3W_Plh.js`, donc sans le redemander) : 1 requête de plus, le même jour (`download`
  de `lib/net.ts`, son User-Agent).

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
  prix d'avant (le format du guide a changé), rien n'est écrit et la tâche échoue. La liste des
  produits, qui ne sert qu'à la liste de souhaits, n'arrête jamais les prix du jour (testé) :
  illisible (téléchargement en échec, fichier renommé, format changé), tronquée (moins de la
  moitié des produits qu'elle donnait : les autres perdraient leur extension, et leur ligne) ou
  impossible à enregistrer, celle d'avant reste, le journal le dit, et elle est relue au guide
  suivant. L'écriture,
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
cartes, japonaise (`/carte/jp/<id>`) ou française (`/carte/<id>`, de la même forme :
`carte.cardmarketPrices`, `carte.priceHistory.cardmarket`), porte ses prix des **180 derniers
jours** au plus, presque jour par jour. Pour chaque carte du catalogue, dans les deux langues, avec
un id Cardmarket (environ 28 000 japonaises et 25 000 françaises), une fois : la série de la carte
elle-même (`mainHistory`, testé : son produit Cardmarket, celui du catalogue, sans variante
« Reverse » ni version, au prix suivi « avg30 », la même règle que `prices`, pour une française
comme pour une japonaise ; seulement les jours écrits AAAA-MM-JJ, une autre forme tomberait entre
deux jours), et chaque jour avant le dernier relevé prend son prix (`mergePrices`, testé :
celui-là et les suivants restent ceux du relevé). L'année de la carte est lue, fusionnée et
réécrite, avec son prix d'il y a 30 jours, en une transaction `IMMEDIATE` où se lit aussi le jour
du dernier relevé (`mergeHistory`, testé avec deux processus) : la tâche `prices` (le service
`ingest`) écrit les mêmes lignes pendant que `history` tourne dans le conteneur `cards`, et une
année lue avant sa transaction effacerait le prix du jour en se réécrivant. Une page toutes les
3 s : environ 23 h pour les japonaises la première fois, 21 h de plus pour les françaises ; les
séries les plus récentes d'abord, toutes langues mêlées ; chaque carte lue une fois
(`history_imports`, une ligne par langue et par carte : `historyTodo`, testé, l'id 7091 japonais
lu ne fait pas sauter le français), un passage suivant ne lit que les nouvelles ; 10 pages en
échec d'affilée arrêtent la lecture ; des cartes en échec font échouer la tâche (relues au passage
suivant). Le prix d'il y a 30 jours de chaque carte reprise suit, et l'avancée est notée
(`sources` : `history`, toutes les 100 cartes et en fin de passage, même arrêté par les échecs),
que suit l'ETag des prix. Une carte reprise ne l'est plus : si son id Cardmarket change ensuite
(le catalogue adopte celui que Pokécardex a corrigé), les 180 jours de son nouveau produit ne sont
pas repris, seulement les relevés suivants (le corriger demanderait une étape du schéma : le
produit repris dans `history_imports`).

L'historique est celui d'un **produit Cardmarket** (`cardmarket_history`, par id produit) : une
carte française qui partage son produit avec une autre carte (de toute langue) en reprend les prix
dans la même ligne, ce qui est attendu. La série « récente » du prix suivi (`prices`) se juge dans
la langue de la carte : sa série (`sets`, par langue et code), jamais celle du même code dans
l'autre langue.

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
  catalogue leur correspondent, **en anglais** (`sets.expansion_name`, voir « Catalogue » : pour une
  japonaise, son nom ; pour une française, son nom anglais confirmé par les adresses Cardmarket de
  ses cartes). Un seul nom d'extension parmi les séries du catalogue de l'extension (sans les
  espaces des bords), porté par aucune autre extension ; sinon, pas de ligne (Cardmarket
  ajouterait « toutes versions »).
- Les cartes françaises : leur produit Cardmarket est celui de toutes les langues, et leur ligne
  est celle d'une japonaise (`1x Bulbasaur Bind Down (Mega Evolution)`), jamais écrite en français
  (le nom d'une série française, « Méga-Évolution », n'est pas celui de l'extension). Une série
  française sans nom d'extension (`expansion_name` vide : nom anglais illisible ou non confirmé)
  est ignorée : si elle est la seule de son extension, pas de ligne ; si une série japonaise de la
  même extension en a un, c'est ce nom-là. La série d'une carte se joint par sa langue **et** son
  code (un code se répète d'une langue à l'autre : la série « SVP » japonaise n'est pas la
  française). Le nombre d'extensions qui portent un nom se compte sur les cartes des deux langues :
  un nom porté par deux extensions, l'une par des cartes japonaises et l'autre par des françaises,
  n'a pas de ligne non plus ; un produit que portent une carte japonaise et une française n'est
  qu'une extension (un seul compte).
- Pas de ligne non plus pour un produit inconnu, sans extension ou sans métacarte, ni pour une
  parenthèse dans le nom ou l'extension. Ni la langue ni l'état ne tiennent dans une ligne.
- Calculée à chaque demande (`Cache-Control: no-cache`), requêtes préparées une fois, chaque id et
  chaque extension une fois par demande : 1 025 ids en moins de 0,1 s.

## État des tâches (`status.ts`)

`runs` note chaque passage (`runs.ts`, `ingest.ts`) : son début, sa fin, s'il a réussi, et la
cause d'un échec (`message` : celui de l'erreur, ou « interrompue » pour un passage arrêté).
Pendant qu'il tourne, il donne signe de vie chaque minute (`alive_at`) : une tâche n'est pas lancée
deux fois à la fois (deux processus doubleraient le rythme des requêtes), ni `catalog` pendant
`history` ou l'inverse (testé : toutes deux lisent les pages de Pokécardex, une toutes les 3 s en
tout, rythme que chaque processus ne tient que pour lui ; une étape de `cards` qui trouve l'autre
en cours est alors passée, comme une tâche déjà en cours), mais un passage sans
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
