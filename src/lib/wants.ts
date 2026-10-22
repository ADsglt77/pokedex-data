/**
 * La ligne d'une carte pour la liste de souhaits Cardmarket (« Ajouter une deck list »), que rend
 * `/v1/wants` : jamais une ligne qui pourrait désigner une autre carte (une mauvaise version
 * achèterait une autre carte).
 */

/** Un numéro imprimé fait de chiffres seulement, en nombre (« 037 » : 37) ; `null` sinon. */
const numericNumber = (number: string | null) =>
  number !== null && /^\d+$/.test(number) ? Number(number) : null

/**
 * La version (V.n) d'un produit Cardmarket parmi les produits de la même carte dans la même
 * extension. Cardmarket les numérote dans l'ordre de leur numéro imprimé, pas de leur création
 * (vérifié par l'utilisateur, octobre 2026 : Toxtricity VMAX de Rebellion Crash, S2 037 = V.1 bien
 * que créée après S2 107 = V.2 ; Pokémon Card 151, sv2a 004 = V.1, sv2a 168 = V.2). `number` : son
 * numéro imprimé, d'après le catalogue ; `sameCard` : celui de chaque produit de la carte dans
 * l'extension, le sien compris (`null` : inconnu, absent du catalogue ou ambigu). `null` quand elle
 * ne peut pas être donnée sûrement : un numéro inconnu ou pas fait que de chiffres (« TG01 »,
 * « SV-P »), ou deux produits au même numéro. Une mauvaise version achèterait une autre carte.
 */
export function wantsVersion(
  number: string | null,
  sameCard: readonly (string | null)[],
): number | null {
  const own = numericNumber(number)
  const numbers = sameCard.map(numericNumber).filter((other) => other !== null)
  if (own === null || numbers.length < sameCard.length || new Set(numbers).size < numbers.length) {
    return null
  }
  return 1 + numbers.filter((other) => other < own).length
}

/**
 * Le nom d'extension Cardmarket d'une série du catalogue (`sets.expansion_name`, japonaise ou
 * française : en anglais), et le nombre d'extensions Cardmarket dont des cartes du catalogue, de
 * toute langue, portent une série de ce nom (espaces des bords ignorées), elle comprise.
 */
export interface ExpansionName {
  name: string
  expansions: number
}

/**
 * La ligne d'une carte pour « Ajouter une deck list » d'une liste de souhaits Cardmarket (format
 * vérifié par l'utilisateur en octobre 2026) : `1x Charmander Blazing Destruction Steady
 * Firebreathing (V.2) (Pokémon Card 151)`, que Cardmarket ajoute comme « Salamèche (sv2a 168) ».
 * Son nom chez Cardmarket sans crochets, « | » devenu une espace ; sa version (`wantsVersion`)
 * quand l'extension a plusieurs produits de la même carte (`sameCard`, comme pour `wantsVersion`),
 * sans quoi Cardmarket prendrait la V.1 ; le nom de son extension (`expansionNames` : les noms
 * d'extension des séries du catalogue de cette extension Cardmarket, d'une carte japonaise ou
 * française), sans les espaces des bords (Pokécardex en laisse : « Shining Legends  »). `null`
 * quand elle ne désignerait pas sûrement cette carte : version incertaine ; pas exactement un nom
 * d'extension, ou un nom que porte aussi une autre extension (deux séries « Beginning Set »,
 * « Jumbo » sur sept extensions) : Cardmarket ajouterait « n'importe quelle version » ; ou une
 * parenthèse dans le nom ou l'extension (Cardmarket la lirait mal). Toujours 1 exemplaire ; ni la
 * langue ni l'état ne s'y écrivent.
 */
export function wantsLine(
  product: { name: string; number: string | null },
  sameCard: readonly (string | null)[],
  expansionNames: readonly ExpansionName[],
): string | null {
  const [only, ...others] = expansionNames
  if (only === undefined || others.length > 0 || only.expansions > 1) return null
  const expansion = only.name.trim()
  if (/[()]/.test(product.name + expansion)) return null
  // Seul de sa carte dans l'extension : pas de version, Cardmarket prend la seule qu'il a.
  let version = ''
  if (sameCard.length > 1) {
    const rank = wantsVersion(product.number, sameCard)
    if (rank === null) return null
    version = ` (V.${rank})`
  }
  const card = product.name.replaceAll(/[[\]]/g, '').replaceAll(' | ', ' ')
  return `1x ${card}${version} (${expansion})`
}
