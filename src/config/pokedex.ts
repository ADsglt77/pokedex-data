/** Le Pokédex national : ses générations et les types des Pokémon (PokéAPI). */

import type { GenerationId, PokemonTypeId } from '@/contract'

export const GENERATIONS: readonly { id: GenerationId; first: number; last: number }[] = [
  { id: 1, first: 1, last: 151 },
  { id: 2, first: 152, last: 251 },
  { id: 3, first: 252, last: 386 },
  { id: 4, first: 387, last: 493 },
  { id: 5, first: 494, last: 649 },
  { id: 6, first: 650, last: 721 },
  { id: 7, first: 722, last: 809 },
  { id: 8, first: 810, last: 905 },
  { id: 9, first: 906, last: 1025 },
]

export const TOTAL_SPECIES = GENERATIONS.at(-1)!.last

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
