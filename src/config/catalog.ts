/**
 * Le catalogue (tâche `catalog`, `worker/ingest/catalog.ts`) : ce que deviennent les champs de
 * TCGdex (copiés par l'importateur `pokecodex-importer`) dans ses réponses. TCGdex les écrit en
 * français pour les cartes françaises, en anglais pour les japonaises : chaque table a les deux.
 * Configuration, pas de logique.
 */

import type { CardLanguage, CardType } from '@/contract'

/**
 * Le nom d'une réponse du catalogue (`rest` : `sets`, `sets/<id>`, `species/<n°>`) : les
 * japonaises gardent leurs noms (`catalog/sets`), les françaises ont les leurs
 * (`catalog/fr/sets`). Écrite par la tâche `catalog`, lue par le Worker.
 */
export const snapshotName = (lang: CardLanguage, rest: string) =>
  lang === 'ja' ? `catalog/${rest}` : `catalog/fr/${rest}`

/**
 * L'id d'une série chez TCGdex (« SV2a », « sv03.5 », « SM1+ ») que servent les routes du
 * catalogue (`/v1/catalog/sets/<id>`) et que nomment ses réponses dans R2 ; une série d'un autre id
 * n'entre pas au catalogue (le journal le dit).
 */
export const SET_ID = /^[A-Za-z0-9.+_-]{1,32}$/

/**
 * Les séries de TCGdex écartées du catalogue (leur id, `series.tcgdex_id`) : celles de Pokémon TCG
 * Pocket, des cartes numériques (décision du propriétaire, novembre 2026).
 */
export const EXCLUDED_SERIES = ['tcgp']

/** La catégorie d'une carte (`cards.category` de l'importateur). */
export const CATEGORIES = new Map<string, 'pokemon' | 'trainer' | 'energy'>([
  ['Pokémon', 'pokemon'],
  ['Pokemon', 'pokemon'],
  ['Dresseur', 'trainer'],
  ['Trainer', 'trainer'],
  ['Énergie', 'energy'],
  ['Energy', 'energy'],
])

/** Le type (`CardType`) d'un Pokémon, d'après sa première énergie (`types[0]` de TCGdex). */
export const POKEMON_TYPES = new Map<string, CardType>([
  ['Plante', 'grass'],
  ['Grass', 'grass'],
  ['Feu', 'fire'],
  ['Fire', 'fire'],
  ['Eau', 'water'],
  ['Water', 'water'],
  ['Électrique', 'lightning'],
  ['Lightning', 'lightning'],
  ['Psy', 'psychic'],
  ['Psychic', 'psychic'],
  ['Combat', 'fighting'],
  ['Fighting', 'fighting'],
  ['Obscurité', 'darkness'],
  ['Darkness', 'darkness'],
  ['Métal', 'metal'],
  ['Metal', 'metal'],
  ['Fée', 'fairy'],
  ['Fairy', 'fairy'],
  ['Dragon', 'dragon'],
  ['Incolore', 'colorless'],
  ['Colorless', 'colorless'],
])

/** Le type d'un dresseur, d'après sa catégorie (`trainerType`) ; sinon `trainer`. */
export const TRAINER_TYPES = new Map<string, CardType>([
  ['Objet', 'item'],
  ['Item', 'item'],
  ['Supporter', 'supporter'],
  ['Stade', 'stadium'],
  ['Stadium', 'stadium'],
  ['Outil', 'tool'],
  ['Tool', 'tool'],
  ['Machine Technique', 'technical-machine'],
  ['Technical Machine', 'technical-machine'],
])

/** Le type d'une énergie, d'après `energyType` ; sinon `energy`. */
export const ENERGY_TYPES = new Map<string, CardType>([
  ['De base', 'basic-energy'],
  ['Normal', 'basic-energy'],
  ['Basic', 'basic-energy'],
  ['Spécial', 'special-energy'],
  ['Special', 'special-energy'],
])

/**
 * Les raretés, de la plus commune à la plus rare (leur rang : leur place ici) : [nom en français,
 * puis chaque écriture de TCGdex qui la désigne, en français et en anglais (les japonaises)]. Les
 * noms sont ceux de TCGdex en français (pour une rareté qu'il n'a qu'en japonais, sa traduction),
 * sauf « Magnifique rare », qu'il donne aux rares secrètes
 * (576 de ses 602 cartes, le 13 novembre 2026, ont un numéro au-delà du nombre officiel de leur
 * série : Pikachu bw1-115, Mew cel25-25) : « Rare secrète ». Une rareté absente d'ici garde son
 * nom, après toutes celles-ci.
 */
const RARITY_ORDER: [name: string, ...written: string[]][] = [
  ['Sans Rareté', 'Sans Rareté', 'None'],
  ['Commune', 'Commune', 'Common'],
  ['Peu Commune', 'Peu Commune', 'Uncommon'],
  ['Rare', 'Rare'],
  ['Holo Rare', 'Holo Rare', 'Rare Holo'],
  ['Promo', 'Promo'],
  ['Rare Holo LV.X', 'Rare Holo LV.X'],
  ['Rare Prime', 'Rare Prime', 'Rare PRIME'],
  ['LÉGENDE', 'LÉGENDE', 'LEGEND'],
  ['Holo Rare V', 'Holo Rare V', 'Rare Holo V'],
  ['Holo Rare VMAX', 'Holo Rare VMAX', 'Rare Holo VMAX'],
  ['Holo Rare VSTAR', 'Holo Rare VSTAR', 'Rare Holo VSTAR'],
  ['Radieux Rare', 'Radieux Rare', 'Radiant Rare'],
  ['Double rare', 'Double rare', 'Double Rare'],
  ['Triple rare', 'Triple Rare'],
  ['HIGH-TECH rare', 'HIGH-TECH rare', 'ACE SPEC Rare'],
  ['Collection Classique', 'Collection Classique', 'Classic Collection'],
  ['Dresseur Full Art', 'Dresseur Full Art', 'Full Art Trainer'],
  ['Illustration rare', 'Illustration rare', 'Art Rare'],
  ['Personnage rare', 'Character Rare'],
  ['Ultra Rare', 'Ultra Rare', 'Super Rare'],
  ['Personnage super rare', 'Character Super Rare'],
  ['Shiny rare', 'Shiny rare', 'Shiny Rare'],
  ['Shiny rare V', 'Shiny rare V'],
  ['Shiny rare VMAX', 'Shiny rare VMAX'],
  ['Chromatique ultra rare', 'Chromatique ultra rare', 'Shiny Ultra Rare', 'Shiny Super Rare'],
  ['Magnifique', 'Magnifique', 'Amazing Rare'],
  [
    'Illustration spéciale rare',
    'Illustration spéciale rare',
    'Special illustration rare',
    'Special Art Rare',
  ],
  ['Rare secrète', 'Magnifique rare', 'Secret Rare'],
  ['Hyper rare', 'Hyper rare', 'Hyper Rare'],
  ['Noir Blanc rare', 'Black White Rare'],
  ['Méga hyper rare', 'Mega Hyper Rare'],
]

/** Chaque rareté telle que l'écrit TCGdex : [son nom en français, son rang]. */
export const RARITIES = new Map(
  RARITY_ORDER.flatMap(([name, ...written], rank) =>
    written.map((text): [string, [string, number]] => [text, [name, rank]]),
  ),
)

/** Le rang d'une rareté absente de `RARITIES` : après toutes les autres. */
export const UNKNOWN_RARITY_RANK = RARITY_ORDER.length

/** Le nom d'une version (`variants_detailed[].type` de TCGdex, en minuscules). */
export const VERSIONS = new Map([
  ['normal', 'Normale'],
  ['reverse', 'Reverse'],
  ['holo', 'Holo'],
  ['métal', 'Métal'],
  ['metal', 'Métal'],
  ['lenticular', 'Lenticulaire'],
])

/** Le nom de la version première édition, et les tampons de TCGdex qui la désignent (`stamp`). */
export const FIRST_EDITION = '1re édition'
export const FIRST_EDITION_STAMPS = new Set(['1re Édition', '1st Edition'])

/**
 * Sans `variants_detailed`, les versions d'après les drapeaux de TCGdex (`variants`), dans cet
 * ordre.
 */
export const VERSION_FLAGS: [flag: string, name: string][] = [
  ['normal', 'Normale'],
  ['reverse', 'Reverse'],
  ['holo', 'Holo'],
  ['firstEdition', FIRST_EDITION],
]
