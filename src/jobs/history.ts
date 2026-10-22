/**
 * Tâche `history` : l'historique des prix des 180 derniers jours, repris de Pokécardex (avec son
 * accord, octobre 2026 : Cardmarket n'en garde pas, Pokécardex le relève chaque jour). La page de
 * chaque carte du catalogue, japonaise (`/carte/jp/<id>`) ou française (`/carte/<id>`), avec un id
 * Cardmarket porte ses prix des 180 derniers jours, presque jour par jour ; on en prend ceux de la
 * carte elle-même (`mainHistory` : son produit Cardmarket, son prix suivi, la règle que suit aussi
 * la tâche `prices`, d'où des courbes d'un seul tenant), et chacun prend son jour dans
 * l'historique, avant celui du dernier relevé (`mergePrices`) : l'historique est celui d'un produit
 * Cardmarket, que toutes les langues partagent. À la demande (après le catalogue : `bun run ingest
 * cards`) ; une page toutes les 3 s : les quelque 28 000 cartes japonaises prennent environ 23 h la
 * première fois. Chaque carte n'est lue qu'une fois (`history_imports`, par langue : `historyTodo`) :
 * un passage suivant ne lit que les nouvelles cartes du catalogue, et un passage interrompu reprend
 * là où il en était. Les séries les plus récentes d'abord. Son prix d'il y a 30 jours suit, et son
 * avancée est notée (`sources` : `history`, toutes les 100 cartes et en fin de passage) : l'ETag
 * des prix et des historiques change, les courbes la montrent aussitôt.
 */

import type { Database } from 'bun:sqlite'
import type { CardLanguage } from '@/contract'
import { readSource, writeSource } from '../db'
import { historyStore, mergePrices } from '../history'
import { MAX_FAILURES_IN_A_ROW, readCard, type PokecardexCardPage } from '../lib/pokecardex'
import { plural, TerminalProgress } from '../terminal-progress'

/**
 * Les prix de la carte elle-même dans sa page (testé) : sa plus longue période, la série de son
 * produit Cardmarket (`cardmarket` : celui du catalogue ; s'il n'est plus celui de Pokécardex, rien)
 * sans version ni variante, au prix suivi par la tâche `prices` (« avg30 » : la tendance pour une
 * série récente, la moyenne sur 30 jours ensuite). Les versions (« Reverse Masterball ») et les
 * variantes (« Reverse ») sont d'autres prix : jamais mêlés. `null` sans historique.
 */
export function mainHistory(
  page: PokecardexCardPage,
  cardmarket: number,
): [date: string, price: number][] | null {
  const product = page.carte.cardmarketPrices?.find(({ id_version }) => id_version === null)
  if (Number(product?.id_cardmarket) !== cardmarket) return null
  const periods = page.carte.priceHistory?.cardmarket ?? {}
  const longest = Object.keys(periods).sort((a, b) => Number(b) - Number(a))[0]
  const history = longest === undefined ? undefined : periods[longest]
  const series = history?.series.find(
    ({ versionId, variant, metric }) =>
      versionId === null && variant === 'normale' && metric === 'avg30',
  )
  if (!history || !series) return null
  const points = history.points.flatMap(({ date, [series.id]: price }) =>
    typeof price === 'number' && price > 0
      ? [[date, Math.round(price * 100) / 100] as [string, number]]
      : [],
  )
  return points.length ? points : null
}

/**
 * Les cartes à reprendre (testé) : celles du catalogue avec un id Cardmarket, absentes de
 * `history_imports` pour leur langue (l'id 7091 de chaque langue est une autre carte), les séries
 * les plus récentes d'abord.
 */
export function historyTodo(db: Database) {
  return db
    .query(
      `SELECT cards.lang, cards.id, cards.cardmarket
       FROM cards JOIN sets ON sets.lang = cards.lang AND sets.id = cards.set_id
       WHERE cards.cardmarket != 0 AND NOT EXISTS (
         SELECT 1 FROM history_imports WHERE lang = cards.lang AND card = cards.id)
       ORDER BY sets.released DESC, cards.lang, cards.id`,
    )
    .all() as { lang: CardLanguage; id: number; cardmarket: number }[]
}

export async function history(db: Database) {
  const todo = historyTodo(db)
  if (!todo.length) return
  const done = db.query(
    'INSERT OR REPLACE INTO history_imports (lang, card, read_at) VALUES (?, ?, ?)',
  )
  const writeMonthAgo = db.query('UPDATE cardmarket_prices SET month_ago = ? WHERE id = ?')
  const store = historyStore(db)
  /** L'avancée de la reprise, que suit l'ETag des prix et des historiques (`pricesTag`). */
  const progress = () => {
    const now = new Date().toISOString()
    writeSource(db, 'history', { stamp: now, date: now.slice(0, 10) })
  }
  // Le jour du dernier relevé : lui et les suivants restent ceux de la tâche `prices`.
  const until = readSource(db, 'cardmarket')?.date ?? null
  let read = 0
  let days = 0
  let inARow = 0
  let failed = 0
  const bar = new TerminalProgress('Historique des prix', todo.length)
  try {
    for (const [index, card] of todo.entries()) {
      try {
        const points = mainHistory(await readCard(card.lang, card.id), card.cardmarket)
        if (points) {
          days += mergePrices(db, card.cardmarket, points, until)
          if (until) writeMonthAgo.run(store.monthAgo(card.cardmarket, until), card.cardmarket)
        }
        done.run(card.lang, card.id, new Date().toISOString())
        read++
        inARow = 0
        if (read % 100 === 0) progress()
      } catch (error) {
        bar.clear()
        console.warn(
          `  carte ${card.lang} ${card.id} :`,
          error instanceof Error ? error.message : error,
        )
        failed++
        if (++inARow >= MAX_FAILURES_IN_A_ROW) {
          throw new Error(`${inARow} pages en échec d’affilée : la lecture s’arrête là`, {
            cause: error,
          })
        }
        bar.redraw()
      } finally {
        bar.update(index + 1)
      }
    }
    bar.finish()
  } catch (error) {
    bar.stop()
    throw error
  }
  progress()
  console.log(
    `Historique (Pokécardex) : ${plural(read, 'carte lue', 'cartes lues')}, ` +
      plural(days, 'jour écrit', 'jours écrits'),
  )
  // Rien n'est noté pour elles : relues au prochain passage, qui ne lit qu'elles et les nouvelles.
  if (failed) {
    throw new Error(
      `${plural(failed, 'carte en échec, relue', 'cartes en échec, relues')} au prochain passage`,
    )
  }
}
