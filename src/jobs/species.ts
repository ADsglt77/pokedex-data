/**
 * Tâche `species` : les 1 025 espèces, d'après PokéAPI (nom en français, anglais et japonais,
 * types, génération ; catégorie, description, taille, poids…), une fois par mois : elles ne
 * changent qu'avec une nouvelle génération (à ajouter alors dans `GENERATIONS`). En fin de tâche,
 * les réponses de `/v1/species` et `/v1/species/details` sont recalculées.
 */

import type { Database } from 'bun:sqlite'
import { GENERATIONS, POKEMON_TYPES, SPECIES_IDS, TOTAL_SPECIES } from '@/config/pokedex'
import type {
  PokemonSpecies,
  PokemonSpeciesDetails,
  PokemonTypeId,
  SpeciesDetailsFile,
  SpeciesFile,
} from '@/contract'
import { fetchJson, mapPool } from '../lib/net'
import { saveSnapshot } from '../snapshots'

const API = 'https://pokeapi.co/api/v2'

interface Localized {
  language: { name: string }
}

interface RawSpecies {
  id: number
  names: (Localized & { name: string })[]
  genera: (Localized & { genus: string })[]
  flavor_text_entries: (Localized & { flavor_text: string })[]
  is_baby: boolean
  is_legendary: boolean
  is_mythical: boolean
}

interface RawPokemon {
  types: { slot: number; type: { name: string } }[]
  height: number | null
  weight: number | null
}

// La langue des kana est `ja-hrkt` aujourd'hui, `ja-Hrkt` dans les anciennes données.
const inLanguage = <T extends Localized>(entries: T[], language: string) =>
  entries.filter((entry) => entry.language.name.toLowerCase() === language)

const firstName = (species: RawSpecies, language: string) =>
  inLanguage(species.names, language)
    .map((entry) => entry.name.trim())
    .find(Boolean) ?? null

/**
 * Un texte de Pokédex mis en page pour l'écran du jeu, sur une ligne : un tiret conditionnel
 * avant un saut de ligne marque un mot coupé, un tiret visible est gardé (« demi-journée »).
 */
const cleanFlavorText = (text: string) =>
  text
    .replace(/\xad[\r\n\f]+/g, '')
    .replace(/([\p{L}\p{N}])-[\r\n\f]+(?=[\p{L}\p{N}])/gu, '$1-')
    .replace(/[ \t\r\n\v\f\xad]+/g, ' ')
    .trim()

/** Dixièmes d'unité → unités. Aucun Pokémon ne mesure 0 : cela veut dire « inconnu ». */
const fromTenths = (value: number | null) => (value && value > 0 ? value / 10 : null)

/** Un type de PokéAPI que l'app connaît (`POKEMON_TYPES`). */
const isKnownType = (type: string): type is PokemonTypeId => POKEMON_TYPES.has(type)

/**
 * L'espèce telle que la lit l'app. Sans nom français ou anglais, ou d'un type inconnu (une nouvelle
 * génération que PokéAPI n'a pas encore toute traduite) : une erreur, la tâche échoue et les
 * espèces d'avant restent (l'app planterait sur un nom absent, partout).
 */
function normalize(species: RawSpecies, pokemon: RawPokemon) {
  const generation = GENERATIONS.find((row) => species.id >= row.first && species.id <= row.last)!
  const genus = inLanguage(species.genera, 'fr')
    .map((entry) => entry.genus.trim())
    .find(Boolean)
  const fr = firstName(species, 'fr')
  const en = firstName(species, 'en')
  if (!fr || !en) throw new Error(`Espèce ${species.id} : pas de nom français ou anglais`)
  const types = [...pokemon.types].sort((a, b) => a.slot - b.slot).map(({ type }) => type.name)
  const unknown = types.find((type) => !isKnownType(type))
  if (unknown) throw new Error(`Espèce ${species.id} : type inconnu (${unknown})`)

  const entry: PokemonSpecies = {
    id: species.id,
    names: { fr, en, ja: firstName(species, 'ja-hrkt') ?? firstName(species, 'ja') },
    types: types.filter(isKnownType),
    generation: generation.id,
  }
  const details: PokemonSpeciesDetails = {
    id: species.id,
    // La génération IX omet le « Pokémon » de la catégorie.
    genus: genus ? (genus.startsWith('Pokémon') ? genus : `Pokémon ${genus}`) : null,
    // L'entrée des jeux les plus récents.
    description:
      inLanguage(species.flavor_text_entries, 'fr')
        .map((flavor) => cleanFlavorText(flavor.flavor_text))
        .findLast(Boolean) ?? null,
    heightM: fromTenths(pokemon.height),
    weightKg: fromTenths(pokemon.weight),
    isBaby: species.is_baby,
    isLegendary: species.is_legendary,
    isMythical: species.is_mythical,
  }
  return { entry, details }
}

export async function species(db: Database) {
  console.log(`Lecture des ${TOTAL_SPECIES} espèces sur PokéAPI…`)
  const rows = await mapPool(SPECIES_IDS, 8, async (id) => {
    const [raw, pokemon] = await Promise.all([
      fetchJson<RawSpecies>(`${API}/pokemon-species/${id}`),
      fetchJson<RawPokemon>(`${API}/pokemon/${id}`),
    ])
    return normalize(raw, pokemon)
  })

  // Ensemble : la liste et les détails restent d'accord. Dans la forme que lit l'app (`satisfies`) :
  // une clé renommée ne passerait pas la compilation.
  db.transaction(() => {
    saveSnapshot(db, 'species', {
      species: rows.map(({ entry }) => entry),
    } satisfies SpeciesFile)
    saveSnapshot(db, 'species-details', {
      details: rows.map(({ details }) => details),
    } satisfies SpeciesDetailsFile)
  })()
  console.log(`${rows.length} espèces enregistrées`)
}
