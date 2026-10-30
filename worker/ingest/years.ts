/**
 * L'historique en base (`cardmarket_history`, une ligne par carte et par année), tel que l'écrivent
 * les tâches `prices` (le prix du jour) et `history` (les jours repris de Pokécardex), qui peuvent
 * tourner en même temps sur les mêmes lignes : chacune lit l'année, la complète, et ne la réécrit
 * que si elle n'a pas changé entre-temps (`writeYears`) ; sinon, elle la relit. Sans cela, l'une
 * effacerait ce que l'autre vient d'écrire (le prix du jour, irremplaçable).
 */

import { env } from 'cloudflare:workers'
import type { HistoryYear } from '@/lib/history'

/** Une année lue, avec son texte tel qu'en base (`text`), pour la réécrire sans rien effacer. */
interface StoredYear extends HistoryYear {
  id: number
  text: string
}

/** Les années `years` des cartes `ids`, telles qu'en base. */
export async function readYears(ids: number[], years: number[]) {
  const { results } = await env.DB.prepare(
    `SELECT id, year, first, prices AS text FROM cardmarket_history
     WHERE id IN (SELECT value FROM json_each(?)) AND year IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids), JSON.stringify(years))
    .all<{ id: number; year: number; first: number; text: string }>()
  return results.map((row): StoredYear => ({ ...row, prices: JSON.parse(row.text) }))
}

/** Une année à écrire : la nouvelle, et le texte de celle lue (`null` : elle n'existait pas). */
export interface YearWrite {
  id: number
  year: number
  first: number
  prices: string
  old: string | null
}

/**
 * Écrit les années, chacune seulement si celle en base est encore celle lue (`old`), d'un seul
 * tenant ; rend celles qu'une autre tâche a changées entre-temps, à relire et refaire.
 */
export async function writeYears(rows: YearWrite[]) {
  if (!rows.length) return []
  const json = JSON.stringify(rows)
  const [inserted, updated] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cardmarket_history (id, year, first, prices)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.year'),
              json_extract(value, '$.first'), json_extract(value, '$.prices')
       FROM json_each(?) WHERE json_extract(value, '$.old') IS NULL
       ON CONFLICT DO NOTHING RETURNING id, year`,
    ).bind(json),
    env.DB.prepare(
      `UPDATE cardmarket_history
       SET first = json_extract(sent.value, '$.first'), prices = json_extract(sent.value, '$.prices')
       FROM json_each(?) AS sent
       WHERE cardmarket_history.id = json_extract(sent.value, '$.id')
         AND cardmarket_history.year = json_extract(sent.value, '$.year')
         AND cardmarket_history.prices = json_extract(sent.value, '$.old')
       RETURNING cardmarket_history.id, cardmarket_history.year`,
    ).bind(json),
  ])
  const written = new Set(
    [...inserted!.results, ...updated!.results].map((row) => {
      const { id, year } = row as { id: number; year: number }
      return `${id}|${year}`
    }),
  )
  return rows.filter(({ id, year }) => !written.has(`${id}|${year}`))
}
