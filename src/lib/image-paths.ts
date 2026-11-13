/**
 * Les chemins des images (le site les rend à son adresse, `/images/…`), sans nom de source : le
 * scan d'une carte et le logo d'une série, que copie l'importateur `pokecodex-importer` dans R2
 * (`cards/…`) ; le sprite et l'illustration d'un Pokémon, que copie la tâche `sprites`
 * (`images/species/…`). Communs à la tâche `catalog`, qui donne l'image de chaque carte et le logo
 * de chaque série (`importedKey`), et à l'API, qui les sert (`worker/images.ts`) : `imagePathOf`
 * dit les parties de chacun. Leurs gabarits sont dans le contrat (`CardScanPath`…) : même règle que
 * `../pokedex/src/lib/card-images.ts` (et `spriteUrl`, `artworkUrl` de son `config/pokedex.ts`),
 * qui les écrit dans les collections.
 */

import type { ArtworkPath, CardLanguage, ImageKey, SpritePath } from '@/contract'

/**
 * Une partie d'une clé de l'importateur (sa série, sa carte) : seuls `A-Z a-z 0-9 . -` y restent
 * tels quels, tout autre octet devient `_XX` (« SM1+ » : `SM1_2B`). Rien d'autre n'y est permis.
 */
const PART = '(?:[A-Za-z0-9.-]|_[0-9A-F]{2})+'

/** `.` et `..` ne sont jamais une partie, ni d'une clé ni d'un chemin. */
const plain = (parts: string[]) => parts.every((part) => part !== '.' && part !== '..')

/** Les clés R2 des images de l'importateur : le scan d'une carte, le logo d'une série. */
const IMPORTED = {
  card: new RegExp(`^cards/(ja|fr)/(${PART})/(${PART})\\.webp$`),
  logo: new RegExp(`^cards/(ja|fr)/(${PART})/_logo\\.webp$`),
}

/**
 * L'`ImageKey` d'une image de l'importateur dans la langue `lang`, d'après sa clé R2 : le scan
 * `cards/fr/sv03.5/sv03.5-006.webp` → `fr/sv03.5/sv03.5-006`, le logo `cards/fr/sv03.5/_logo.webp`
 * → `fr/sv03.5`. '' sans clé, ou pour une clé d'une autre forme ou d'une autre langue (une carte
 * française ne montre jamais une image japonaise).
 */
export function importedKey(kind: 'card' | 'logo', lang: CardLanguage, key: string | null) {
  const match = key === null ? null : IMPORTED[kind].exec(key)
  if (!match || match[1] !== lang || !plain(match.slice(2))) return ''
  return match.slice(1).join('/') as ImageKey
}

/**
 * Le sprite et l'illustration officielle d'un Pokémon. L'illustration est un WebP sans perte,
 * converti une fois hors du Worker (`docs/donnees.md`) depuis son PNG de PokéAPI, que copie la
 * tâche `sprites` (`artworkSource`).
 */
export const spriteUrl = (id: number): SpritePath => `/images/species/${id}.png`
export const artworkUrl = (id: number): ArtworkPath => `/images/species/artwork/${id}.webp`
export const artworkSource = (id: number) => `/images/species/artwork/${id}.png` as const

/**
 * Chaque sorte de chemin servi et ses parties : la langue, la série, la carte et la taille d'un
 * scan (`CardScanPath`) ; la langue et la série d'un logo (`SetLogoPath`) ; le numéro d'un Pokémon
 * (son sprite, le PNG de son illustration, encore servi pendant la transition vers le WebP :
 * « élargir puis restreindre », et son illustration en WebP).
 */
const IMAGE_PATHS = {
  card: new RegExp(`^/images/cards/(ja|fr)/(${PART})/(${PART})-(md|hd)\\.webp$`),
  logo: new RegExp(`^/images/sets/(ja|fr)/(${PART})\\.webp$`),
  sprite: /^\/images\/species\/(\d{1,4})\.png$/,
  artworkSource: /^\/images\/species\/artwork\/(\d{1,4})\.png$/,
  artwork: /^\/images\/species\/artwork\/(\d{1,4})\.webp$/,
}

type ImageKind = keyof typeof IMAGE_PATHS

/** La sorte d'un chemin servi et ses parties ; `null` s'il n'est pas un chemin d'image. */
export function imagePathOf(path: string) {
  for (const [kind, pattern] of Object.entries(IMAGE_PATHS) as [ImageKind, RegExp][]) {
    const match = pattern.exec(path)
    if (match) return plain(match.slice(1)) ? { kind, parts: match.slice(1) } : null
  }
  return null
}
