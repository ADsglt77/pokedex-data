/**
 * Le contrat de l'API : la forme de chacune de ses réponses (`/v1/…`), et les gabarits des chemins
 * de ses images. Le site en garde une copie (`src/types.ts` du Pokédex), vérifiée par
 * `bun run contracts` du site (et par `bun run lint` ici, quand le site est à côté). Une forme qui
 * change : la règle « élargir puis restreindre » de `../pokedex/docs/deploiement.md` (un champ
 * ajouté facultatif d'abord, jamais un tuple réordonné) ; une réponse tirée des prix change
 * `FORMAT` (`snapshots.ts`), une réponse gardée dans R2 change en trois temps.
 */

/* Les espèces (PokéAPI) : `/v1/species`, `/v1/species/details` */

export type PokemonTypeId =
  | 'normal'
  | 'fire'
  | 'water'
  | 'electric'
  | 'grass'
  | 'ice'
  | 'fighting'
  | 'poison'
  | 'ground'
  | 'flying'
  | 'psychic'
  | 'bug'
  | 'rock'
  | 'ghost'
  | 'dragon'
  | 'dark'
  | 'steel'
  | 'fairy'

export type GenerationId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/**
 * Le nombre d'espèces du Pokédex national, celles des générations de `GenerationId` : une
 * génération ajoutée change les deux ensemble (le site d'abord : `../pokedex/docs/deploiement.md`).
 */
export type TotalSpecies = 1025

export interface PokemonSpecies {
  /** Numéro du Pokédex national. */
  id: number
  names: { fr: string; en: string; ja: string | null }
  types: PokemonTypeId[]
  generation: GenerationId
}

/** Ce que dit le jeu d'une espèce : chargé à la première fiche ouverte. */
export interface PokemonSpeciesDetails {
  id: number
  genus: string | null
  description: string | null
  heightM: number | null
  weightKg: number | null
  isBaby: boolean
  isLegendary: boolean
  isMythical: boolean
}

export interface SpeciesFile {
  species: PokemonSpecies[]
}

export interface SpeciesDetailsFile {
  details: PokemonSpeciesDetails[]
}

/* Le catalogue (TCGdex, copié par l'importateur `pokecodex-importer`) : `/v1/catalog/…` */

/**
 * La langue des cartes : japonaises (`ja`) ou françaises (`fr`). Chaque réponse du catalogue est
 * dans sa langue, de même forme : `/v1/catalog/…` pour les japonaises, `/v1/catalog/fr/…` pour les
 * françaises, dont la « sortie » est celle en France (au Japon pour les japonaises).
 */
export type CardLanguage = 'ja' | 'fr'

/**
 * Le chemin d'une image chez nous, sans son préfixe ni sa taille : `<langue>/<série>/<carte>` pour
 * le scan d'une carte (`CardScanPath`), `<langue>/<série>` pour le logo d'une série
 * (`SetLogoPath`) ; ses parties encodées comme les clés de l'importateur (seuls `A-Z a-z 0-9 . -`
 * restent tels quels, tout autre octet devient `_XX`). '' : aucune image.
 */
export type ImageKey = string

/**
 * Le type d'une carte, le même dans les deux langues : l'énergie d'un Pokémon (`grass`, `fire`,
 * `water`, `lightning`, `psychic`, `fighting`, `darkness`, `metal`, `fairy`, `dragon`,
 * `colorless`), la catégorie d'un dresseur (`item`, `supporter`, `stadium`, `tool`,
 * `technical-machine`, `trainer` sans précision) ou d'une énergie (`basic-energy`,
 * `special-energy`, `energy` sans précision). '' : inconnu. Le site les nomme
 * (`CARD_TYPES` de `../pokedex/src/config/catalog.ts`).
 */
export type CardType = string

/**
 * Une carte du catalogue : [série, numéro, id Cardmarket (0 : aucun), nom (tel que TCGdex le donne
 * dans la langue de la carte), image (`ImageKey`, '' : aucune), rareté (clé de `rarities`, '' :
 * inconnue), type (`CardType`), ses Pokémon s'ils sont plusieurs].
 */
export type CatalogRow = [string, string, number, string, ImageKey, string, CardType, number[]?]

/**
 * `/v1/catalog/species/<n°>` (`/v1/catalog/fr/species/<n°>` pour les françaises) : les cartes
 * Pokémon d'un Pokémon dans sa langue, avec leurs séries et leurs raretés (tâche `catalog`,
 * `worker/ingest/catalog.ts`) : la fenêtre d'ajout.
 */
export interface CatalogFile {
  /**
   * Clé : l'id de la série chez TCGdex (« SV2a », « sv03.5 ») ; [nom, date de sortie (au Japon, en
   * France pour une série française ; YYYY-MM-DD, '' si inconnue), logo (`ImageKey`)].
   */
  sets: Record<string, [name: string, released: string, logo: ImageKey]>
  /** Clé : numéro du Pokémon ; ses cartes, des plus récentes aux plus anciennes. */
  cards: Partial<Record<string, CatalogRow[]>>
  /**
   * Clé : une rareté de ces cartes, telle que TCGdex l'écrit (« Double rare ») ; [son nom en
   * français, son rang, de la plus commune à la plus rare].
   */
  rarities: Record<string, [name: string, rank: number]>
}

/**
 * `/v1/catalog/sets` (`/v1/catalog/fr/sets` pour les françaises) : les séries du catalogue de sa
 * langue, pour la page Catalogue (tâche `catalog`).
 */
export interface CatalogSetsFile {
  /** Les blocs (les « séries » de TCGdex : « Écarlate et Violet »), des plus récents aux plus anciens. */
  blocks: string[]
  /**
   * Des plus récentes aux plus anciennes : [id (« SV2a »), nom, sortie (comme `CatalogFile`), logo
   * (`ImageKey`), nombre de cartes, rang de son bloc dans `blocks` (-1 : aucun)].
   */
  sets: [id: string, name: string, released: string, logo: ImageKey, cards: number, block: number][]
}

/** Une carte d'une série, telle que la donne `/v1/catalog/sets/<id>`. */
export interface CatalogSetRow {
  /** Le numéro de sa référence (`localId` de TCGdex : « 006 »), unique dans la série. */
  number: string
  /** Le numéro tel qu'imprimé : « 006/165 » ; son numéro seul sans nombre officiel de cartes. */
  printed: string
  /** Son nom, tel que TCGdex le donne dans la langue de la carte. */
  name: string
  /** Ses Pokémon ; aucun pour un dresseur ou une énergie. */
  dexIds: number[]
  /** 0 : aucun. */
  cardmarket: number
  /** `ImageKey` ; '' : aucune. */
  image: ImageKey
  /** Clé de `rarities` ; '' : inconnue. */
  rarity: string
  /** `CardType`. */
  type: CardType
  /** '' : inconnu. */
  illustrator: string
  /** Ses versions, en français : « Normale », « Reverse », « Holo »… */
  versions: string[]
}

/**
 * `/v1/catalog/sets/<id>` (`/v1/catalog/fr/sets/<id>` pour les françaises) : toutes les cartes
 * d'une série, dans son ordre, et leurs raretés.
 */
export interface CatalogSetFile {
  cards: CatalogSetRow[]
  rarities: CatalogFile['rarities']
}

/*
 * Les chemins des images (`/v1/images/…`, que le site sert sous `/images/…` ;
 * `lib/image-paths.ts`), sans nom de source. Celui du scan d'une carte est gardé tel quel dans les
 * collections des comptes ; les autres se recalculent à l'affichage.
 */

/** La taille d'un scan : `md` pour les grilles et les listes, `hd` en grand. */
export type ImageSize = 'md' | 'hd'
/** Le scan d'une carte : son `ImageKey` (`<langue>/<série>/<carte>`), sa taille. */
export type CardScanPath = `/images/cards/${string}-${ImageSize}.webp`
/** Le logo d'une série : son `ImageKey` (`<langue>/<série>`). */
export type SetLogoPath = `/images/sets/${string}.webp`
/**
 * Le sprite et l'illustration officielle d'un Pokémon ; l'illustration en WebP sans perte,
 * convertie une fois hors du Worker (novembre 2026, `docs/donnees.md`).
 */
export type SpritePath = `/images/species/${number}.png`
export type ArtworkPath = `/images/species/artwork/${number}.webp`

/* L'état des tâches d'ingestion : `/v1/status` (`status.ts`) */

/**
 * Où en est une tâche : à jour, en retard (pas de réussite depuis deux de ses intervalles), en
 * échec (son dernier passage), jamais passée, ou, pour les prix, figés (le guide de Cardmarket
 * inchangé depuis plus de deux jours). Une tâche à la demande n'est jamais en retard.
 */
export type JobState = 'ok' | 'late' | 'failed' | 'never' | 'frozen'

export interface ServerStatus {
  /**
   * Chaque tâche, dans l'ordre de `INGEST_JOBS`. La cause d'un échec n'est pas rendue : elle est
   * dans le journal du Worker (`npx wrangler tail pokedex-data`, ou ses journaux chez Cloudflare)
   * et dans `runs.message`.
   */
  jobs: { job: string; label: string; state: JobState }[]
}

/* Les prix : `/v1/prices/…`, `/v1/histories`, `/v1/wants` (tâche `prices`) */

/** Le prix du jour d'une carte, en court : prix du marché, plus bas, prix d'il y a 30 jours. */
export type CardPriceRow = [price: number, low: number | null, monthAgo: number | null]

/**
 * `/v1/prices?ids=…` : les prix Cardmarket du jour des cartes demandées ; 404 tant que le guide
 * n'a jamais été lu.
 */
export interface PriceFile {
  /** Jour du guide des prix (YYYY-MM-DD). */
  date: string
  /**
   * Clé : id Cardmarket (`idProduct`), une par carte demandée ; `null` : sans prix ce jour.
   */
  cards: Record<string, CardPriceRow | null>
}

/**
 * `/v1/wants?ids=…` : pour chaque id Cardmarket demandé (`idProduct`), sa ligne pour « Ajouter
 * une deck list » d'une liste de souhaits Cardmarket (`wantsLine`), ou `null` quand elle ne
 * désignerait pas sûrement cette carte-là (produit inconnu, extension ambiguë…).
 */
export type WantsLines = Record<string, string | null>

/** `/v1/prices/<idProduct>` : l'historique d'une carte (Cardmarket n'en garde pas). */
export interface CardPriceHistory {
  /** Son nom chez Cardmarket : « Leafeon V [Greening Cells | Leaf Blade] ». */
  name: string | null
  /** Le premier jour (YYYY-MM-DD). */
  from: string
  /** Un prix par jour depuis `from` ; `null` sans prix ce jour-là. */
  prices: (number | null)[]
}

/**
 * `/v1/histories?ids=…` : l'historique de chaque id Cardmarket demandé, en une demande (la courbe
 * de la valeur de la collection) ; `null` sans historique.
 */
export type PriceHistories = Record<string, CardPriceHistory | null>
