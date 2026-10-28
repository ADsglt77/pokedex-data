/**
 * L'historique des prix des cartes Cardmarket demandées (`/v1/prices/:id`, `/v1/histories`),
 * d'après la base (`cardmarket_history`, une ligne par carte et par année) : chacune `null` sans
 * historique, ses années mises bout à bout (`joinYears`), avec son nom chez Cardmarket (`null`
 * hors de la liste des produits). Une seule requête, quel que soit le nombre de cartes (jusqu'à
 * 1 025).
 */

import { env } from 'cloudflare:workers'
import type { CardPriceHistory } from '@/contract'
import { joinYears, type HistoryYear } from '@/lib/history'

interface Row {
  id: number
  year: number
  first: number
  prices: string
  name: string | null
}

export async function readHistories(ids: number[]) {
  const { results } = await env.DB.prepare(
    `SELECT history.id, history.year, history.first, history.prices, products.name
     FROM cardmarket_history AS history
     LEFT JOIN cardmarket_products AS products ON products.id = history.id
     WHERE history.id IN (SELECT value FROM json_each(?)) ORDER BY history.id, history.year`,
  )
    .bind(JSON.stringify(ids))
    .all<Row>()
  const years = new Map<number, { name: string | null; years: HistoryYear[] }>()
  for (const { id, year, first, prices, name } of results) {
    const card = years.get(id) ?? { name, years: [] }
    card.years.push({ year, first, prices: JSON.parse(prices) })
    years.set(id, card)
  }
  const histories: Record<number, CardPriceHistory | null> = {}
  for (const id of ids) {
    const card = years.get(id)
    const joined = card && joinYears(card.years)
    histories[id] = joined ? { name: card.name, ...joined } : null
  }
  return histories
}
