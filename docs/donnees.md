# Les données

Ce que lit chaque tâche d'ingestion, ce qu'elle range dans la D1 et R2, et ce qu'en rend l'API. À
lire avant de toucher à ce domaine (les règles : `CLAUDE.md`). Les tâches tournent dans le Worker
(`worker/ingest/`, les chemins ci-dessous en partent), un Workflow par passage, par étapes : une
étape en échec est réessayée seule (deux fois, une puis deux minutes plus tard ; chaque essai a
30 min, au-delà il compte comme une panne : `RETRIES`, `ingest/workflow.ts`), et un passage
arrêté reprend où il en était.

## Espèces (`ingest/species.ts`, chaque mois)

Les 1 025 espèces d'après PokéAPI (nom français, anglais et japonais, types, génération ; catégorie,
description, taille, poids…), lues par `ingest/net.ts` (requêtes identifiées, deux par espèce, six
espèces à la fois, réessayées en cas de panne), par étapes de 100 espèces : `/v1/species` et
`/v1/species/details` (des réponses enregistrées dans R2). Une espèce sans nom français ou anglais,
ou d'un type inconnu (une nouvelle génération pas encore traduite), fait échouer la tâche : les
espèces d'avant restent. Une nouvelle génération s'ajoute au contrat (`GenerationId`,
`TotalSpecies`), le site d'abord, puis ici dans `GENERATIONS` et `TOTAL_SPECIES`
(`config/pokedex.ts`), puis les tâches `species`, `sprites` et `catalog` (l'ordre et pourquoi :
`../pokedex/docs/deploiement.md`).

## Catalogue (`ingest/catalog.ts`, chaque jour)

**D'après TCGdex, par l'importateur.** Depuis le 13 novembre 2026, le catalogue vient de
[TCGdex](https://tcgdex.dev), que copie un Worker à part, l'importateur `pokecodex-importer` (dépôt
`../pokecodex-api`, son `README.md` décrit sa base) : toutes les cartes françaises et japonaises de
TCGdex dans sa base D1 `pokecodex-cards` (`series`, `sets`, `cards` ; le document de TCGdex de
chaque carte dans `cards.metadata_json`), et leurs images dans le bucket R2 `pokedex-data`, sous
`cards/…` (section suivante). Ce Worker les lit seulement (liaisons `CARDS` et `IMPORTS`) et ne
fait aucune requête vers TCGdex. Le catalogue de Pokécardex, ses tables (`sets`, `cards`,
`card_species`, `rarities`, `history_imports`) et ses images ont été retirés le même jour
(décision du propriétaire, migration `0004` ; le bucket vidé de `images/` et `snapshots/` à la
main) : ne jamais réintroduire de lecture de Pokécardex.

- **Ce qui entre au catalogue** : chaque carte d'une langue (`cards.language`, `ja` ou `fr`), sauf
  celles que TCGdex ne liste plus (`removed_at`, que l'importateur note sans les effacer) et celles
  des séries de Pokémon TCG Pocket (la série TCGdex `tcgp` : des cartes numériques, 15 extensions
  françaises le 13 novembre 2026 ; `EXCLUDED_SERIES`, `config/catalog.ts`). Une extension sans
  carte retenue n'a pas de réponse. Les ids des extensions et des cartes se répètent d'une langue à
  l'autre (« P ») : chaque langue a ses réponses, et son miroir.
- **Lu sans tout charger** (le Worker a 128 Mo) : les champs du détail de chaque carte sont
  extraits par la base (`json_extract` : `dexId`, `types[0]`, `trainerType`, `energyType`,
  `variants_detailed`, `variants`), par pages de 2 000 cartes dans l'ordre de l'index
  `(language, tcgdex_id)` de l'importateur. Une carte dont l'importateur n'a pas encore lu le
  détail (`metadata_json` vide : 13 000 japonaises sur 13 156 le 13 novembre 2026, lues dans la
  nuit) est gardée dans sa série, son nom et son image seulement : ni Pokémon (absente de la
  fenêtre d'ajout), ni type, ni rareté, ni versions, ni id Cardmarket (ni prix). Elle les a au
  passage qui suit (chaque jour).
- **Une carte** (`CatalogSetRow` du contrat ; testé, `worker/tests/catalog.test.ts`) :
  - `number` : son `localId` (« 006 », « TG01 ») ; `printed` : `localId/nombre officiel`, le nombre
    écrit avec autant de chiffres que le numéro (« 006/165 », « 001/073 », « 4/102 »), quand
    l'extension a un nombre officiel de cartes (`official_cards` > 0) et que le numéro n'est fait
    que de chiffres ; sinon le numéro seul (« TG01 », une promo) ;
  - `name`, `illustrator` : ceux de TCGdex, dans la langue de la carte (en japonais pour une
    japonaise) ;
  - `dexIds` : ses numéros du Pokédex (`dexId`), de 1 à 1 025, chacun une fois ;
  - `cardmarket` : l'id produit (`thirdParty.cardmarket`) de sa version normale sans tampon, sinon
    d'une version normale, sinon de la première version qui en a un, sinon 0. Le tampon compte :
    une version normale tamponnée (« Pokémon Center ») est souvent un autre produit (Carapuce
    sv03.5-007 : 733 602, sa version tamponnée 721 198) ;
  - `type` (`CardType` du contrat) : pour un Pokémon (`category` « Pokémon », « Pokemon » en
    japonais), sa première énergie (`grass`… `colorless`) ; pour un dresseur, sa catégorie
    (`trainerType` : `item`, `supporter`, `stadium`, `tool`, `technical-machine`, sinon `trainer`) ;
    pour une énergie (`energyType`), `basic-energy`, `special-energy`, sinon `energy` ; '' sans
    catégorie (détail pas lu) ou pour une énergie de Pokémon inconnue. TCGdex écrit ces champs en
    français pour les cartes françaises (« Feu », « Objet », « De base »), en anglais pour les
    japonaises : les tables de `config/catalog.ts` ont les deux ;
  - `rarity` : la rareté telle que l'écrit TCGdex (« Double rare », « Common » ; vide si inconnue :
    l'importateur écrit `NULL` pour le « None » des japonaises) ; chaque réponse donne, pour chaque
    rareté de ses cartes, `[nom en français, rang]`, d'après la table ordonnée `RARITIES`, de la plus
    commune à la plus rare : les noms français de TCGdex, les anglais des japonaises traduits
    (« Common » : « Commune », « Art Rare » : « Illustration rare », « Special Art Rare » :
    « Illustration spéciale rare »), et « Magnifique rare », que TCGdex donne aux rares secrètes
    (576 de ses 602 cartes ont un numéro au-delà du nombre officiel), nommée « Rare secrète ». Une
    rareté absente de la table garde son nom, au rang qui suit toutes les autres ;
  - `versions` : les versions de TCGdex (`variants_detailed[].type`), en français (« Normale »,
    « Reverse », « Holo », « Métal »…), chacune une fois, et « 1re édition » si l'une porte ce tampon ;
    sans versions détaillées, d'après ses drapeaux (`variants`) ;
  - `image` : son `ImageKey` (`fr/sv03.5/sv03.5-006`), tiré de sa clé R2 (`image_r2_key`) seulement
    si l'importateur l'a copiée (`image_status` : `downloaded`, `recovered_from_cdn` ou
    `already_present`), de la forme exacte de ses clés et de la langue de la carte ; sinon '' (la
    carte de substitution du site).
- **Une extension** : son id chez TCGdex (« SV2a », « sv03.5 », « SM1+ » ; seulement les ids que
  servent les routes, `SET_ID` : une autre est écartée, le journal le dit), son nom, sa sortie
  (`release_date`, en YYYY-MM-DD, '' sinon ; au Japon pour une japonaise, en France pour une
  française), son logo (`ImageKey`, `fr/sv03.5`, seulement si l'importateur l'a copié :
  `sets.logo_status` à `downloaded`, sa clé `sets.logo_r2_key` ; ces deux colonnes, ajoutées par
  l'importateur en novembre 2026, sont nulles tant qu'il ne les a pas remplies, et les extensions
  japonaises n'ont pas de logo chez TCGdex), et son bloc : sa série chez TCGdex (« Écarlate et
  Violet » ; en japonais, son nom japonais).
- **Les réponses**, recalculées à chaque passage, dans R2 (`snapshots/…`), seulement celles qui ont
  changé (leur MD5 comparé à l'ETag de R2, `saveSnapshot`) ; celles du japonais nommées `catalog/…`,
  celles du français `catalog/fr/…` (`snapshotName`), servies aux routes de même nom
  (`worker/reference.ts`) :
  - `/v1/catalog/species/<n°>` : les cartes Pokémon d'un Pokémon (une réponse pour chacun des
    1 025, même sans carte), des plus récentes aux plus anciennes, et dans une extension de la
    dernière à la première : `[extension, numéro, id Cardmarket, nom, image, rareté, type, Pokémon
    s'ils sont plusieurs]` ; chaque extension `[nom, sortie, logo]` ; les raretés ;
  - `/v1/catalog/sets` : les extensions, des plus récentes aux plus anciennes (le même jour, dans
    l'ordre de leur id), `[id, nom, sortie, logo, nombre de cartes, rang de son bloc (-1 : aucun)]`,
    et les blocs, dans l'ordre de leur extension la plus récente ;
  - `/v1/catalog/sets/<id>` : toutes les cartes d'une extension, dans son ordre (par le nombre en tête
    de leur numéro, celles qui n'en ont pas ensuite, puis par le numéro, ses nombres comparés en
    nombres : « BW9 » avant « BW10 »), et leurs raretés. Celles des extensions qui n'ont plus de
    cartes sont retirées (dans leur langue seulement).
- **Le miroir** (`catalog_cards`, D1) : chaque carte retenue, par langue, extension et numéro, avec
  son id Cardmarket et la sortie de son extension dans sa langue ; ce que lit la tâche `prices`
  (« Prix »). Réécrit d'un seul tenant à chaque passage, seulement les lignes qui changent ; une
  carte qui n'est plus au catalogue en est retirée.
- **Les gardes** (testées) : une langue sans aucune carte, ou avec moins de la moitié des cartes de
  son miroir (la base de l'importateur vidée, son format changé), n'écrit rien, ni réponses ni
  miroir ; l'autre langue est faite, puis la tâche échoue (la page Réglages et la surveillance le
  disent : deux jours sans réussite, et `/v1/health` répond 503). Tant qu'aucune carte d'une langue
  n'a été lue, ses réponses répondent 404. Une étape par langue (`catalogue ja`, `catalogue fr`),
  qui redit son signe de vie à chaque page de cartes et à chaque réponse écrite. Le journal compte,
  par langue, les extensions, les cartes, et celles sans détail, sans id Cardmarket ou sans image.

## Images (`worker/images.ts`, `ingest/sprites.ts`)

Servies à `/v1/images/…` depuis R2, gardées un an par les clients (`immutable`) ; une image de
repli (la grande image pour un scan `md` dont la petite n'est pas encore copiée, le PNG d'une
illustration pas encore convertie en WebP), un jour seulement, pour que la bonne la remplace
ensuite (testé). Sinon 404, sans rien télécharger (une réponse sans cache : l'image est servie dès
qu'elle est copiée) ; le site
montre alors la carte de substitution. Les chemins ne nomment aucune source (`lib/image-paths.ts`).
Seulement un chemin de la forme exacte de son gabarit (`imagePathOf`, testé) : la langue `ja` ou
`fr` ; chaque partie (extension, carte) faite de `A-Z a-z 0-9 . -` et de `_XX` (deux chiffres
hexadécimaux majuscules), comme les clés de l'importateur, ni `.` ni `..` ; la taille `md` ou `hd`.

| Chemin | Image (clé R2) |
|---|---|
| `/images/cards/<langue>/<extension>/<carte>-hd.webp` | Le scan d'une carte, copié de TCGdex par l'importateur : `cards/<langue>/<extension>/<carte>.webp` (`IMPORTS`) |
| `/images/cards/<langue>/<extension>/<carte>-md.webp` | Sa petite image, `….low.webp`, ou la grande tant que l'importateur ne l'a pas copiée |
| `/images/sets/<langue>/<extension>.webp` | Le logo d'une extension : `cards/<langue>/<extension>/_logo.webp` (`IMPORTS`) |
| `/images/species/<n>.png` | Le sprite d'un Pokémon, PokéAPI : `images/species/<n>.png` (`FILES`) |
| `/images/species/artwork/<n>.webp` | Son illustration officielle, en WebP sans perte (`images/species/artwork/<n>.webp`), ou son PNG tant que le WebP n'est pas converti (ci-dessous) |
| `/images/species/artwork/<n>.png` | Le PNG de l'illustration, copié de PokéAPI par la tâche `sprites` : la source de son WebP (encore servi pendant la transition) |

- **Les images des cartes et des extensions** : copiées par l'importateur (`cards/…`), jamais par
  ce Worker, qui les lit dans sa liaison `IMPORTS` (le même bucket que `FILES` en ligne ; une
  liaison à part pour qu'en développement elle puisse viser les images de l'importateur sans que
  les écritures des tâches, `FILES`, y aillent jamais). La langue est dans le chemin comme dans la
  clé : un chemin français ne mène qu'à une image française (testé). Le scan `md` peut changer une
  fois, de la grande image à la petite quand l'importateur la copie : la même carte, plus légère ;
  l'importateur ne remplace jamais une image copiée. Le catalogue ne donne une image ou un logo
  que s'ils sont copiés (« Catalogue »).
- **Les images des Pokémon** (`FILES`), copiées **toutes d'avance** par la tâche `sprites`, à la
  demande (`bun run ingest sprites`, et dans `setup`) : le sprite et le PNG de l'illustration de
  chacun des 1 025 Pokémon, seulement ceux qui manquent, deux téléchargements à la fois, par
  étapes de 100 Pokémon ; seulement un PNG de 5 Mo au plus (testé). Une image en erreur n'arrête
  pas les autres : la tâche échoue à la fin, pour être relancée (à la 20e erreur, elle s'arrête : la
  source est sans doute en panne). Leur adresse d'origine n'est que dans `UPSTREAMS`
  (`ingest/sprites.ts`).
- **Les illustrations des Pokémon, en WebP sans perte** (décision D-10, lot L19, novembre 2026) :
  les 1 025 PNG de PokéAPI (475 × 475, transparents, 100 avec un profil de couleur) faisaient
  132,7 Mo ; leurs WebP sans perte font 83,2 Mo (−37,3 %), chacun identique à son PNG au pixel
  près, aux mêmes dimensions et au même profil de couleur. Le Worker ne sait pas encoder un WebP :
  la tâche `sprites` copie le PNG (`artworkSource`), et un script ponctuel, hors du Worker et
  **hors des dépôts** (`../conversion-illustrations-webp.mjs`, `../procedure-A-09.md`), en fait le
  WebP (`images/species/artwork/<n>.webp`). Tant que le WebP d'une illustration manque, l'API sert
  son PNG au chemin du WebP (`image/png`, testé) : le bucket ayant été vidé le 13 novembre 2026, et
  le script n'étant pas sur le poste de développement, les illustrations sont servies en PNG
  jusqu'à la prochaine conversion. **Un environnement neuf** : `bun run ingest setup` (la tâche
  `sprites` copie les 1 025 sprites et PNG), puis, le Worker local arrêté,
  `node ../conversion-illustrations-webp.mjs --mesure`, puis sans `--mesure` (ses contrôles : sans
  perte, mêmes dimensions, même profil, mêmes pixels RGBA ; au moindre écart, rien n'est écrit).

## Prix (`ingest/prices.ts`, toutes les 6 h)

Le guide des prix public de Cardmarket et sa liste des produits (`products_singles_6.json`),
seulement les cartes à l'unité (catégorie 51) :

- `cardmarket_products` : le nom de chaque produit, son extension (`idExpansion`) et sa carte
  (`idMetacard`) ; vides pour un produit sorti de la liste. Son nom est celui que rend
  l'historique d'une carte.
- `cardmarket_prices` : le prix du jour de chaque carte, son plus bas et son prix d'il y a 30 jours
  (`month_ago`, d'après l'historique, une semaine plus tôt au plus : `priceBefore`).
- `cardmarket_history` (`ingest/years.ts`) : l'historique, irremplaçable (Cardmarket n'en garde
  pas), une ligne par carte et par année, à partir de son premier jour avec un prix. Celui d'un
  **produit Cardmarket** (par id produit) : une carte française qui partage son produit avec une
  autre carte en a les prix dans la même ligne, ce qui est attendu. L'historique repris de
  Pokécardex jusqu'au 13 novembre 2026 y reste, tel quel.
- **Le prix suivi, partout le même** (décision de l'utilisateur, octobre 2026 : `guidePrice`,
  testée) : la tendance Cardmarket pour une carte d'une série sortie depuis moins de 31 jours, sa
  moyenne sur 30 jours ensuite, à défaut sur 7 jours, puis sur 1 jour (jamais la tendance d'une
  carte ancienne à sa place). La série « récente » se juge dans la langue de la carte, d'après le
  miroir du catalogue (`catalog_cards` : la sortie de TCGdex de son extension, dans sa langue ; une
  carte japonaise et une française de même id d'extension ne se confondent pas, testé). Une valeur
  négative, nulle au centime, ou de 100 000 € ou plus n'est pas un prix (`plausiblePrice`,
  `src/lib/history.ts`, testé : la moyenne suivante, ou aucun prix ; le plus bas, `null`).
- Les gardes : relancée le même jour, la tâche remplace le prix du jour ; moins de la moitié des
  prix d'avant (le format du guide a changé), rien n'est écrit et la tâche échoue. La liste des
  produits n'arrête jamais les prix du jour (testé) : illisible (téléchargement en échec, fichier
  renommé, format changé), tronquée (moins de la moitié des produits qu'elle donnait) ou impossible
  à enregistrer, celle d'avant reste, le journal le dit, et elle est relue au guide suivant.
  L'historique s'écrit par paquets de 200 cartes ; les prix du jour, mis de côté
  (`cardmarket_prices_next`), ne remplacent ceux de la veille, avec le passage noté, qu'une fois
  tous écrits, d'un seul tenant : arrêtée en route, la tâche n'a rien changé des prix (testé), et
  relancée, elle refait l'historique du jour à l'identique. Deux essais d'une même étape peuvent
  écrire les mêmes années (un essai tenu pour échoué écrit encore pendant le suivant) : chacun ne
  réécrit une année que si elle n'a pas changé depuis sa lecture, sinon il la relit (`writeYears`,
  testé). Le guide et la liste (29 Mo) sont lus en flux (`json-stream.ts`, testé : entiers, ils ne
  tiendraient pas dans la mémoire du Worker) ; un document coupé avant la fin de son tableau est
  refusé, jamais lu comme complet. Rien n'est retéléchargé tant que le guide n'a pas changé
  (`sources` : son `Last-Modified`).
- Les réponses : `/v1/prices?ids=…` (`readPrices` : le jour, et une clé par carte demandée,
  `[prix, plus bas, prix d'il y a 30 jours]` ou `null` sans prix ; 404 tant que le guide n'a
  jamais été lu) ; `/v1/prices/<id>` (l'historique d'une carte) et `/v1/histories?ids=…` (ceux de
  plusieurs, une clé par id, `null` sans historique), assemblés en texte : les prix de chaque année
  tels qu'en base, un `null` par jour manquant entre deux années, jamais relus ni réécrits
  (`joinYears`, testé). Les ids : des entiers de 1 à 9 chiffres sans zéro devant, 1 025 au plus
  (422 sinon). Leur ETag est tiré du passage de la tâche `prices` (`pricesAnswer`, lu avant la
  réponse : au pire des prix neufs sous l'ancien ETag, jamais d'anciens sous le nouveau) : 304 tant
  que rien n'a changé.

## Liste de souhaits (`/v1/wants?ids=…`)

Pour chaque id Cardmarket demandé, sa ligne pour « Ajouter une deck list » de la liste de souhaits
de Cardmarket, ou `null` quand aucune ne désignerait sûrement cette carte-là (une mauvaise version
achèterait une autre carte). Le format, vérifié par l'utilisateur sur cardmarket.com (octobre
2026) : `1x <nom du produit, sans crochets, « | » devenu une espace> (V.<n>) (<extension>)`, où
l'extension est le nom anglais de l'extension Cardmarket de la carte.

**Décision du 13 novembre 2026 : chaque carte a `null`.** Le nom de l'extension Cardmarket venait
de Pokécardex (le nom d'une série japonaise ; pour une française, son nom anglais, confirmé par les
adresses Cardmarket de ses cartes). Aucune source convenue ne le donne désormais :

- la liste des produits de Cardmarket (`cardmarket_products`) donne le nom du produit, l'id de son
  extension et de sa carte, mais aucun nom d'extension (aucun fichier public de Cardmarket n'en a) ;
- TCGdex (relu dans la base de l'importateur le 13 novembre 2026, `sets.metadata_json`) donne, pour
  une extension japonaise, son nom japonais (« ポケモンカード151 ») ; pour une française, son nom
  français, et sur 174 de 203 son code du jeu en ligne (`abbreviation.official`, `tcgOnline` :
  « MEW », « DAA ») et un code localisé (« TEM ») ; aucun nom anglais, aucun nom ni id Cardmarket.

La version (`V.n`, l'ordre des numéros imprimés des produits d'une même carte dans une extension)
se calculerait encore (la liste des produits et le miroir du catalogue), mais une ligne sans le
nom de l'extension, ou avec un nom deviné ou un code que Cardmarket n'a pas été vérifié lire, lui
ferait ajouter « n'importe quelle version », peut-être une autre carte. La route garde sa forme
(`WantsLines` du contrat, ses limites, 422 pour des ids mal écrits) et rend `null` pour chaque
carte ; le site propose alors de l'ajouter depuis sa page Cardmarket (testé,
`worker/tests/wants.test.ts`). Pour rendre des lignes de nouveau : une source du nom anglais de
chaque extension Cardmarket, à convenir avec l'utilisateur (règle des sources, `CLAUDE.md`).

## État des tâches (`worker/status.ts`)

`runs` note chaque passage (`ingest/runs.ts`, `ingest/workflow.ts`) : son début, sa fin, s'il a
réussi, et la cause d'un échec (`message` : celui de l'erreur, ou « interrompue » pour un passage
arrêté). Pendant qu'il tourne, il donne signe de vie à chacune de ses étapes (`alive_at`), et
chaque minute des plus longues (`Alive`, `ingest/workflow.ts` : `catalog` à chaque page de cartes
et à chaque réponse, `prices` après chaque lecture et à chaque paquet) : une tâche n'est pas lancée
deux fois à la fois, mais un passage sans signe de vie depuis 5 min a été arrêté net (son Workflow
terminé, ou en échec sans avoir pu noter sa fin) : il ne bloque plus sa tâche, et il est noté
interrompu à son passage suivant (testé).

Écart connu, reporté (décision D-12 de la revue de novembre 2026) : si l'étape « début » d'un
Workflow est rejouée après que `startRun` a écrit son passage (la réponse perdue), elle trouve ce
passage en vie et saute la tâche (« Tâche déjà en cours ») ; le passage orphelin est noté
interrompu 5 min plus tard. Une tâche à la demande reste « en échec » jusqu'à son prochain
lancement ; `prices` et `catalog` sont rattrapées par le Cron. La correction (une colonne
`runs.instance`, et `startRun` qui rend d'abord le passage ouvert de la même instance) demande une
migration.

Le Cron (toutes les heures, `worker/index.ts`) lance une tâche à rythme quand le début de son
dernier passage terminé a plus que son intervalle (`INGEST_JOBS`) s'il a réussi ; après un échec,
depuis sa fin (un essai coupé à 30 min ne la fait pas repartir aussitôt), 10 min, puis 20, 40…
jusqu'à 6 h (`isDue`, testé : une panne qui dure ne fait pas solliciter la source à chaque fois).
Chaque délai moins 10 min (`CRON_MARGIN`, testé) : une réussite se mesure depuis le début du
passage (sa durée n'y change rien), qui commence un peu après le Cron qui l'a lancé. Les rythmes
réels : `prices` toutes les 6 h, `catalog` chaque jour, `species` chaque mois ; après 1 à 3 échecs
d'affilée, au Cron suivant ; après 4, 2 h plus tard ; après 5, 3 h ; ensuite toutes les 6 h.
Seulement `species`, `catalog` et `prices` : jamais `sprites`, à la demande (testé).

`/v1/status` rend seulement le nom, le libellé et l'état de chaque tâche, dans l'ordre
d'`INGEST_JOBS` (`species`, `catalog`, `sprites`, `prices`). Les détails de calcul restent internes
à l'API. Un passage en cours ne compte pas encore : l'état reste celui du passage d'avant. Les
états : `never` (tâche à la demande jamais passée), `failed` (le dernier passage, ou un passage
arrêté net ; sa cause n'est pas rendue : elle est dans `runs.message` et dans le journal du
Worker), `late` (deux intervalles sans réussite, ou jamais réussie ; jamais pour une tâche à la
demande), `frozen` (les prix : le guide inchangé depuis plus de deux jours, chaque jour perdu
manque pour toujours à l'historique), `ok`. `/v1/health`, sans token : 503 si une tâche à rythme
est en retard (le catalogue après deux jours sans réussite) ou les prix figés (testé).
