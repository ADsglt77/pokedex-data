import type { CardLanguage } from '@/contract'

/**
 * Les types des cartes du catalogue, tels que Pokécardex les numérote (`cards.type`) : ceux des
 * Pokémon, puis les catégories des dresseurs et les énergies. Leur icône est copiée (`typeIcon`).
 */
export const CARD_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 41])

/**
 * Le nom d'une réponse du catalogue (`rest` : `sets`, `sets/<code>`, `species/<n°>`) : les
 * japonaises gardent leurs noms (`catalog/sets`), les françaises ont les leurs
 * (`catalog/fr/sets`). Écrite par la tâche `catalog`, lue par le Worker.
 */
export const snapshotName = (lang: CardLanguage, rest: string) =>
  lang === 'ja' ? `catalog/${rest}` : `catalog/fr/${rest}`
