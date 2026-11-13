/**
 * L'historique en base (`cardmarket_history`, une ligne par carte et par année), tel que l'écrit la
 * tâche `prices` (le prix du jour). Deux essais d'une même étape peuvent écrire les mêmes lignes en
 * même temps (un essai tenu pour échoué écrit encore pendant le suivant : `RETRIES`,
 * `workflow.ts`) : chacun lit l'année, la complète, et ne la réécrit que si elle n'a pas changé
 * entre-temps (`writeYears`, puis `unwritten`) ; sinon, il la relit. Sans cela, l'un effacerait ce
 * que l'autre vient d'écrire (le prix du jour, irremplaçable).
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
 * Les requêtes qui écrivent les années, chacune seulement si celle en base est encore celle lue
 * (`old`) ; aucune sans année à écrire. À envoyer d'un seul tenant (`env.DB.batch`), avec d'autres
 * au besoin, puis leurs résultats à lire par `unwritten`. L'`INSERT` ne reçoit que les années
 * nouvelles, l'`UPDATE` que les autres : chaque texte n'est envoyé qu'une fois (environ 0,8 Mo par
 * paquet de 200 cartes en fin d'année). Le `WHERE true` de l'`INSERT` lève l'ambiguïté de SQLite
 * entre `ON CONFLICT` et le `ON` d'une jointure.
 */
export function writeYears(rows: YearWrite[]) {
  if (!rows.length) return []
  return [
    env.DB.prepare(
      `INSERT INTO cardmarket_history (id, year, first, prices)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.year'),
              json_extract(value, '$.first'), json_extract(value, '$.prices')
       FROM json_each(?) WHERE true ON CONFLICT DO NOTHING RETURNING id, year`,
    ).bind(JSON.stringify(rows.filter(({ old }) => old === null))),
    env.DB.prepare(
      `UPDATE cardmarket_history
       SET first = json_extract(sent.value, '$.first'), prices = json_extract(sent.value, '$.prices')
       FROM json_each(?) AS sent
       WHERE cardmarket_history.id = json_extract(sent.value, '$.id')
         AND cardmarket_history.year = json_extract(sent.value, '$.year')
         AND cardmarket_history.prices = json_extract(sent.value, '$.old')
       RETURNING cardmarket_history.id, cardmarket_history.year`,
    ).bind(JSON.stringify(rows.filter(({ old }) => old !== null))),
  ]
}

/**
 * Les années que les requêtes de `writeYears` n'ont pas écrites, d'après leurs résultats
 * (`answers`) : celles qu'un autre essai a changées entre-temps, à relire et refaire.
 */
export function unwritten(rows: YearWrite[], answers: D1Result[]) {
  const written = new Set(
    answers.flatMap(({ results }) =>
      (results as { id: number; year: number }[]).map(({ id, year }) => `${id}|${year}`),
    ),
  )
  return rows.filter(({ id, year }) => !written.has(`${id}|${year}`))
}
