/**
 * Les chemins des images copiées, que l'API sert (`/v1/images/…`, `images.ts`) et que le site rend
 * à son adresse (`/images/…`) : neutres, sans le nom d'une source. Les adresses d'origine ne sont
 * que dans `UPSTREAMS` (`images.ts`). Le scan d'une carte : le code de sa série et son rang (celui
 * du catalogue), en deux tailles, `md` pour les grilles, `hd` pour la fiche.
 */

export const cardScan = (set: string, rank: number | string, size: 'md' | 'hd') =>
  `/images/cards/${set}/${rank}-${size}.webp`

/** Le logo japonais d'une série, en deux tailles : `md` pour la liste, `hd` en tête de page. */
export const setLogo = (set: string, size: 'md' | 'hd') => `/images/sets/${set}-${size}.webp`

/** L'icône d'un type de carte (`CARD_TYPES`). */
export const typeIcon = (type: number) => `/images/types/${type}.webp`

/** L'icône d'une rareté (« SAR », ●…). */
export const rarityIcon = (rarity: number) => `/images/rarities/${rarity}.webp`

/** Le sprite et l'illustration officielle d'un Pokémon. */
export const spriteUrl = (id: number) => `/images/species/${id}.png`
export const artworkUrl = (id: number) => `/images/species/artwork/${id}.png`
