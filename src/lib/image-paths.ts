/**
 * Les chemins des images (le site les rend à son adresse, `/images/…`), sans nom de source : le
 * scan d'une carte, le logo d'une série, l'icône d'un type ou d'une rareté, le sprite et
 * l'illustration d'un Pokémon. Communs à la tâche `images`, qui les copie (`images.ts`), et au
 * Worker, qui les sert (`worker/images.ts`) : `IMAGE_PATHS` dit les parties de chacun.
 */

import type { CardLanguage } from '@/contract'

/**
 * Le dossier d'une langue dans les chemins : aucun pour le japonais (ses adresses, venues d'abord,
 * n'ont pas changé), `fr/` pour le français. Les codes des séries se répètent d'une langue à
 * l'autre (SVP) : sans lui, deux images auraient le même chemin.
 */
const folderOf = (lang: CardLanguage) => (lang === 'fr' ? 'fr/' : '')

/**
 * Le scan d'une carte : sa langue, le code de sa série et son rang (celui du catalogue), en deux
 * tailles, `md` pour les grilles, `hd` pour la fiche.
 */
export const cardScan = (
  lang: CardLanguage,
  set: string,
  rank: number | string,
  size: 'md' | 'hd',
) => `/images/cards/${folderOf(lang)}${set}/${rank}-${size}.webp`

/** Le logo d'une série, en deux tailles : `md` pour la liste, `hd` en tête de page. */
export const setLogo = (lang: CardLanguage, set: string, size: 'md' | 'hd') =>
  `/images/sets/${folderOf(lang)}${set}-${size}.webp`

/** L'icône d'un type de carte (`CARD_TYPES`). */
export const typeIcon = (type: number) => `/images/types/${type}.webp`

/** L'icône d'une rareté (« SAR », ●…), la même dans les deux langues : une par id chez la source. */
export const rarityIcon = (rarity: number) => `/images/rarities/${rarity}.webp`

/** Le sprite et l'illustration officielle d'un Pokémon. */
export const spriteUrl = (id: number) => `/images/species/${id}.png`
export const artworkUrl = (id: number) => `/images/species/artwork/${id}.png`

/**
 * Chaque sorte de chemin et ses parties : la série, le rang et la taille d'un scan (japonais, ou
 * français : le dossier `fr/`), la série et la taille d'un logo, l'id d'un type, d'une rareté
 * (sans langue : les mêmes ids et la même icône dans les deux) ou d'un Pokémon.
 */
const IMAGE_PATHS = {
  cardJa: /^\/images\/cards\/([A-Z0-9_-]+)\/(\d{1,4})-(md|hd)\.webp$/,
  cardFr: /^\/images\/cards\/fr\/([A-Z0-9_-]+)\/(\d{1,4})-(md|hd)\.webp$/,
  logoJa: /^\/images\/sets\/([A-Z0-9_-]+)-(md|hd)\.webp$/,
  logoFr: /^\/images\/sets\/fr\/([A-Z0-9_-]+)-(md|hd)\.webp$/,
  type: /^\/images\/types\/(\d{1,2})\.webp$/,
  rarity: /^\/images\/rarities\/(\d{1,3})\.webp$/,
  sprite: /^\/images\/species\/(\d{1,4})\.png$/,
  artwork: /^\/images\/species\/artwork\/(\d{1,4})\.png$/,
}

export type ImageKind = keyof typeof IMAGE_PATHS

/** La sorte d'un chemin et ses parties ; `null` s'il n'est pas un chemin d'image. */
export function imagePathOf(path: string) {
  for (const [kind, pattern] of Object.entries(IMAGE_PATHS) as [ImageKind, RegExp][]) {
    const match = pattern.exec(path)
    if (match) return { kind, parts: match.slice(1) }
  }
  return null
}
