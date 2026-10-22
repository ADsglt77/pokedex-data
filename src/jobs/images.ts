/**
 * Tâche `images`, à la demande (après le catalogue : `bun run ingest cards`) : copie d'avance chez
 * nous toutes les images que montre le site (`images.ts`) : l'API n'en télécharge jamais elle-même.
 * Pokécardex prête les siennes à condition qu'elles soient hébergées chez nous, jamais affichées
 * depuis ses serveurs.
 * - D'abord, chaque série du catalogue, japonaise et française : son logo chez Pokécardex, en deux
 *   tailles, ou aucun (noté : `sets.logo`, cherché de nouveau chaque semaine) ; les icônes des types
 *   et des raretés (celles des cartes des deux langues, les mêmes pour un même id). Légers (une
 *   dizaine de Mo), attendus par le choix d'une extension.
 * - Les 1 025 Pokémon : sprite et illustration officielle (PokéAPI).
 * - Chaque carte du catalogue, dans ses deux langues : son scan chez Pokécardex, en deux tailles
 *   (`md` pour les grilles, `hd` pour la fiche), ou aucun. Le résultat est noté (`cards.image`) :
 *   l'app sait d'avance quelle carte n'a pas d'image. Une carte sans scan est recherchée chaque
 *   semaine (Pokécardex en ajoute).
 * Seules les images qui manquent sont téléchargées, deux à la fois : Pokécardex prête ses images,
 * on ne l'inonde pas. Le premier passage (environ 1,5 Go pour les japonaises, de plus pour les
 * françaises) prend une heure ou plus. Une image en erreur (panne, réponse qui n'est pas une
 * image) n'empêche pas les autres : rien n'est noté pour elle, la tâche échoue à la fin pour être
 * relancée, et l'image est redemandée. À la 20e erreur, la source est sans doute en panne : la
 * tâche s'arrête là. En fin de tâche, même arrêtée, les réponses du catalogue sont recalculées
 * (`saveCatalog`).
 */

import type { Database } from 'bun:sqlite'
import { CARD_TYPES } from '@/config/catalog'
import { SPECIES_IDS, TOTAL_SPECIES } from '@/config/pokedex'
import type { CardLanguage } from '@/contract'
import { WEEK } from '@/lib/time'
import { artworkUrl, cardScan, mirror, rarityIcon, setLogo, spriteUrl, typeIcon } from '../images'
import { mapPool } from '../lib/net'
import { saveCatalog } from './catalog'
import { plural, TerminalProgress } from '../terminal-progress'

/** À la 20e erreur, la source est sans doute en panne : on ne la sollicite pas davantage. */
const MAX_FAILURES = 20

export async function images(db: Database) {
  const failed: string[] = []
  let active: TerminalProgress | null = null
  /** Copie une image : `true`, `false` si la source ne l'a pas, `null` en erreur. */
  const copy = async (path: string) => {
    try {
      return await mirror(path)
    } catch (error) {
      failed.push(path)
      active?.clear()
      console.warn(`  ${path} :`, error instanceof Error ? error.message : error)
      if (failed.length >= MAX_FAILURES) {
        throw new Error(`${failed.length} images en erreur : la source est sans doute en panne`, {
          cause: error,
        })
      }
      active?.redraw()
      return null
    }
  }

  try {
    // Les logos jamais cherchés, et ceux absents il y a plus d'une semaine (Pokécardex en ajoute).
    const weekAgo = new Date(Date.now() - WEEK).toISOString()
    const sets = db
      .query(
        `SELECT lang, id FROM sets
         WHERE EXISTS (SELECT 1 FROM cards WHERE cards.lang = sets.lang AND cards.set_id = sets.id)
         AND (logo IS NULL OR (logo = 'none' AND logo_checked < ?))`,
      )
      .all(weekAgo) as { lang: CardLanguage; id: string }[]
    const writeLogo = db.query(
      'UPDATE sets SET logo = ?, logo_checked = ? WHERE lang = ? AND id = ?',
    )
    let logosDone = 0
    active = new TerminalProgress('Logos des séries', sets.length)
    await mapPool(sets, 2, async ({ lang, id }) => {
      const copied = (await copy(setLogo(lang, id, 'md'))) && (await copy(setLogo(lang, id, 'hd')))
      if (copied !== null)
        writeLogo.run(copied ? 'pokecardex' : 'none', new Date().toISOString(), lang, id)
      active?.update(++logosDone)
    })
    active.finish()
    // Les raretés des cartes des deux langues, une icône par id (les mêmes ids, la même icône).
    const rarities = db
      .query(
        `SELECT DISTINCT rarities.id FROM rarities
         JOIN cards ON cards.lang = rarities.lang AND cards.rarity = rarities.id`,
      )
      .all() as { id: number }[]
    const icons = [...CARD_TYPES].map(typeIcon).concat(rarities.map(({ id }) => rarityIcon(id)))
    let iconsDone = 0
    active = new TerminalProgress('Icônes', icons.length)
    await mapPool(icons, 2, async (path) => {
      const result = await copy(path)
      active?.update(++iconsDone)
      return result
    })
    active.finish()

    let speciesDone = 0
    active = new TerminalProgress('Images des Pokémon', TOTAL_SPECIES)
    await mapPool(SPECIES_IDS, 2, async (id) => {
      await copy(spriteUrl(id))
      await copy(artworkUrl(id))
      active?.update(++speciesDone)
    })
    active.finish()

    // Les cartes jamais cherchées, et celles sans scan cherché il y a plus d'une semaine.
    const cards = db
      .query(
        `SELECT lang, id, set_id AS 'set', sort FROM cards
         WHERE image IS NULL OR (image = 'none' AND image_checked < ?)`,
      )
      .all(weekAgo) as { lang: CardLanguage; id: number; set: string; sort: number }[]
    const write = db.query(
      'UPDATE cards SET image = ?, image_checked = ? WHERE lang = ? AND id = ?',
    )
    let found = 0
    let done = 0
    active = new TerminalProgress('Scans des cartes', cards.length)
    await mapPool(cards, 2, async ({ lang, id, set, sort }) => {
      const copied =
        (await copy(cardScan(lang, set, sort, 'md'))) &&
        (await copy(cardScan(lang, set, sort, 'hd')))
      // Noté carte par carte : un premier passage interrompu reprend où il en était. En erreur,
      // rien n'est noté : la carte est cherchée de nouveau au prochain passage.
      if (copied !== null) {
        write.run(copied ? 'pokecardex' : 'none', new Date().toISOString(), lang, id)
      }
      if (copied) found++
      active?.update(++done)
    })
    active.finish()
    active = null
    console.log(
      `Scans cherchés pour ${plural(cards.length, 'carte', 'cartes')} : ${found} chez Pokécardex`,
    )
  } finally {
    active?.stop()
    saveCatalog(db)
  }
  if (failed.length) {
    throw new Error(
      `${plural(failed.length, 'image en erreur, redemandée', 'images en erreur, redemandées')} au prochain passage (${failed.slice(0, 5).join(', ')})`,
    )
  }
}
