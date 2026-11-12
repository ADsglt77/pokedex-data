/** Le Pokédex national : ses générations et les types des Pokémon (PokéAPI). */

import type { GenerationId, PokemonTypeId, TotalSpecies } from '@/contract'

/**
 * Le nombre d'espèces du Pokédex national : celui du contrat (`TotalSpecies`), le même que le
 * site.
 */
export const TOTAL_SPECIES: TotalSpecies = 1025

/**
 * Les numéros de chaque génération du contrat (`GenerationId`) : une génération ajoutée au contrat
 * sans sa ligne ici, et `tsc` échoue ; un numéro jusqu'à `TOTAL_SPECIES` hors de toutes, et la
 * tâche `species` échoue (les espèces d'avant restent), plutôt que de le ranger dans une autre.
 */
const GENERATION_RANGES = {
  1: [1, 151],
  2: [152, 251],
  3: [252, 386],
  4: [387, 493],
  5: [494, 649],
  6: [650, 721],
  7: [722, 809],
  8: [810, 905],
  9: [906, 1025],
} satisfies Record<GenerationId, [first: number, last: number]>

/** Les générations, dans l'ordre (celui des clés numériques d'un objet). */
export const GENERATIONS: readonly { id: GenerationId; first: number; last: number }[] =
  Object.entries(GENERATION_RANGES).map(([id, [first, last]]) => ({
    id: Number(id) as GenerationId,
    first,
    last,
  }))

/** Les numéros du Pokédex national, de 1 à `TOTAL_SPECIES`. */
export const SPECIES_IDS: readonly number[] = Array.from(
  { length: TOTAL_SPECIES },
  (_, index) => index + 1,
)

/** Les types des Pokémon chez PokéAPI (`PokemonTypeId`). */
export const POKEMON_TYPES: ReadonlySet<string> = new Set<PokemonTypeId>([
  'normal',
  'fire',
  'water',
  'electric',
  'grass',
  'ice',
  'fighting',
  'poison',
  'ground',
  'flying',
  'psychic',
  'bug',
  'rock',
  'ghost',
  'dragon',
  'dark',
  'steel',
  'fairy',
])
