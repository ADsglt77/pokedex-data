/**
 * Le contrat de l'API : la forme de chacune de ses réponses (`/v1/…`). Le site en garde une copie
 * (`src/types.ts` du Pokédex) : une réponse qui change de forme change aussi `FORMAT`
 * (`snapshots.ts`), et la copie du site avec elle.
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

/* Le catalogue (Pokécardex) : `/v1/catalog/…` */

/**
 * Une carte du catalogue : [série, numéro (sans numéro imprimé : son rang), id Cardmarket (0 :
 * aucun), nom français, numéro de son image chez Pokécardex (0 : aucune), sa rareté (0 : inconnue),
 * son type (`CARD_TYPES` ; 0 : inconnu), ses Pokémon s'ils sont plusieurs].
 */
export type CatalogRow = [string, string, number, string, number, number, number, number[]?]

/**
 * `/v1/catalog/species/<n°>` : les cartes Pokémon japonaises d'un Pokémon chez Pokécardex, avec
 * leurs séries et leurs raretés (tâche `catalog`, `jobs/catalog.ts`) : la fenêtre d'ajout.
 */
export interface CatalogFile {
  /**
   * Clé : le code de la série chez Pokécardex (« SV2A ») ; [nom, date de sortie au Japon, 1 si son
   * logo est chez nous ou pas encore cherché, 0 si Pokécardex n'en a pas].
   */
  sets: Record<string, [name: string, released: string, logo: 0 | 1]>
  /** Clé : numéro du Pokémon ; ses cartes, des plus récentes aux plus anciennes. */
  cards: Partial<Record<string, CatalogRow[]>>
  /** Clé : le numéro d'une rareté de ces cartes ; [son nom chez Pokécardex, son rang]. */
  rarities: Record<string, [name: string, rank: number]>
}

/** `/v1/catalog/sets` : les séries du catalogue, pour la page Catalogue (tâche `catalog`). */
export interface CatalogSetsFile {
  /** Les blocs du menu de Pokécardex (« Scarlet & Violet »), des plus récents aux plus anciens. */
  blocks: string[]
  /**
   * Des plus récentes aux plus anciennes : [code (« SV2A »), nom, sortie au Japon (YYYY-MM-DD, ''
   * si inconnue), logo (comme `CatalogFile`), nombre de cartes, rang de son bloc dans `blocks` (-1 :
   * aucun), 1 pour un deck].
   */
  sets: [
    id: string,
    name: string,
    released: string,
    logo: 0 | 1,
    cards: number,
    block: number,
    deck: 0 | 1,
  ][]
}

/** Une carte d'une série, telle que la donne `/v1/catalog/sets/<code>`. */
export interface CatalogSetRow {
  /** Le numéro de sa référence (« 006 » ; sans numéro imprimé : son rang), unique dans la série. */
  number: string
  /** Le numéro tel qu'imprimé : « 006/165 », « R/RGB » ; '' sans numéro. */
  printed: string
  /** Son nom français ; '' si Pokécardex ne le donne pas. */
  name: string
  /** Ses noms anglais et allemand ; '' si inconnus. */
  en: string
  de: string
  /** Ses Pokémon ; aucun pour un dresseur ou une énergie. */
  dexIds: number[]
  /** 0 : aucun. */
  cardmarket: number
  /** Le numéro de son image chez Pokécardex ; 0 : aucune. */
  image: number
  /** 0 : inconnue. */
  rarity: number
  /** `CARD_TYPES` ; 0 : inconnu. */
  type: number
  /** '' : inconnu. */
  illustrator: string
  /** « Standard », « Reverse »… */
  versions: string[]
}

/** `/v1/catalog/sets/<code>` : toutes les cartes d'une série, dans son ordre, et leurs raretés. */
export interface CatalogSetFile {
  cards: CatalogSetRow[]
  rarities: CatalogFile['rarities']
}

/* L'état des tâches d'ingestion : `/v1/status` (`status.ts`) */

/**
 * Où en est une tâche : à jour, en retard (pas de réussite depuis deux de ses intervalles), en
 * échec (son dernier passage), jamais passée, ou, pour les prix, figés (le guide de Cardmarket
 * inchangé depuis plus de deux jours). Une tâche à la demande n'est jamais en retard.
 */
export type JobState = 'ok' | 'late' | 'failed' | 'never' | 'frozen'

export interface JobStatus {
  /** Son nom de commande (`bun run ingest prices`). */
  job: string
  /** Son nom affiché (« Prix »). */
  label: string
  /** Son rythme, en ms ; `null` : à la demande. */
  every: number | null
  state: JobState
  /** La fin du dernier passage réussi (ISO) ; `null` s'il n'y en a pas eu. */
  lastSuccess: string | null
  /** La fin du dernier passage, réussi ou non (ISO) : après `lastSuccess`, il a échoué. */
  lastRun: string | null
}

export interface ServerStatus {
  /** Chaque tâche, dans l'ordre de `INGEST_JOBS`. La cause d'un échec : le journal de l'API. */
  jobs: JobStatus[]
  /** Le jour du guide des prix Cardmarket en base ; `null` sans prix. */
  pricesDate: string | null
}

/* Les prix : `/v1/prices/…`, `/v1/histories`, `/v1/wants` (tâches `prices` et `history`) */

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
