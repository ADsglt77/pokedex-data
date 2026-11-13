/**
 * L'historique des prix des cartes Cardmarket demandées (`/v1/prices/:id`, `/v1/histories`),
 * d'après la base (`cardmarket_history`, une ligne par carte et par année) : chacune `null` sans
 * historique, ses années mises bout à bout (`joinYears`), avec son nom chez Cardmarket (`null`
 * hors de la liste des produits). Une seule requête, quel que soit le nombre de cartes (jusqu'à
 * 1 025). La réponse est assemblée en texte, les prix tels qu'en base : jamais relus
 * (`JSON.parse`) ni réécrits.
 */

import { env } from 'cloudflare:workers'
import { joinYears, type StoredYear } from '@/lib/history'

interface Row extends StoredYear {
  id: number
  name: string | null
}

/**
 * Le texte JSON de l'historique de chaque carte `ids` (`CardPriceHistory`), `null` sans
 * historique. `json()` rend les prix en texte compact, tels que les attend `joinYears`.
 */
export async function readHistories(ids: number[]) {
  const { results } = await env.DB.prepare(
    `SELECT history.id, history.year, history.first, json(history.prices) AS prices,
            json_array_length(history.prices) AS length, products.name
     FROM cardmarket_history AS history
     LEFT JOIN cardmarket_products AS products ON products.id = history.id
     WHERE history.id IN (SELECT value FROM json_each(?)) ORDER BY history.id, history.year`,
  )
    .bind(JSON.stringify(ids))
    .all<Row>()
  const years = Map.groupBy(results, ({ id }) => id)
  const histories = new Map<number, string | null>()
  for (const id of ids) {
    const rows = years.get(id)
    if (!rows) {
      histories.set(id, null)
      continue
    }
    const { from, prices } = joinYears(rows)!
    histories.set(
      id,
      `{"name":${JSON.stringify(rows[0]!.name)},"from":"${from}","prices":${prices}}`,
    )
  }
  return histories
}

/**
 * Le texte JSON de `/v1/histories` (`PriceHistories`) : une clé par carte `ids`, dans l'ordre des
 * ids, comme l'écrirait `JSON.stringify`.
 */
export async function readHistoriesText(ids: number[]) {
  const histories = await readHistories(ids)
  const entries = [...histories.keys()]
    .sort((a, b) => a - b)
    .map((id) => `"${id}":${histories.get(id)}`)
  return `{${entries.join()}}`
}
