/**
 * Tâche `history` : l'historique des prix des 180 derniers jours, repris de Pokécardex (avec son
 * accord, octobre 2026 : Cardmarket n'en garde pas, Pokécardex le relève chaque jour). La page de
 * chaque carte du catalogue, japonaise (`/carte/jp/<id>`) ou française (`/carte/<id>`), avec un id
 * Cardmarket porte ses prix des 180 derniers jours, presque jour par jour ; on en prend ceux de la
 * carte elle-même (`mainHistory` : son produit Cardmarket, son prix suivi, la règle que suit aussi
 * la tâche `prices`, d'où des courbes d'un seul tenant), et chacun prend son jour dans
 * l'historique, avant celui du dernier relevé (`mergeHistory`) : l'historique est celui d'un
 * produit Cardmarket, que toutes les langues partagent. À la demande (après le catalogue : `bun run
 * ingest cards`) ; une page toutes les 3 s : les quelque 28 000 cartes japonaises prennent environ
 * 23 h la première fois, les quelque 25 000 françaises 21 h de plus. Chaque carte n'est lue qu'une
 * fois (`history_imports`, par langue : `historyTodo`) : un passage suivant ne lit que les
 * nouvelles cartes du catalogue, et un passage interrompu reprend là où il en était (une carte dont
 * l'id Cardmarket change ensuite n'est pas relue : son nouveau produit n'a que les relevés
 * suivants). Les séries les plus récentes d'abord, par étapes de 50 cartes. Son prix d'il y a
 * 30 jours suit, et son avancée est notée à chaque étape (`sources` : `history`) : l'ETag des prix
 * et des historiques change, les courbes la montrent aussitôt.
 */

import { env } from 'cloudflare:workers'
import type { CardLanguage } from '@/contract'
import {
  monthAgoYears,
  plausiblePrice,
  priceBefore,
  withPrice,
  yearDay,
  type HistoryYear,
} from '@/lib/history'
import { addDays } from '@/lib/time'
import { reasonOf, taskJournal } from '../journal'
import { MAX_FAILURES_IN_A_ROW, readCard, type PokecardexCardPage } from './pokecardex'
import { readSource, writeSource } from './sources'
import type { Alive, Step } from './workflow'
import { readYears, unwritten, writeYears, type YearWrite } from './years'

/**
 * Les prix de la carte elle-même dans sa page (testé) : sa plus longue période, la série de son
 * produit Cardmarket (`cardmarket` : celui du catalogue ; s'il n'est plus celui de Pokécardex, rien)
 * sans version ni variante, au prix suivi par la tâche `prices` (« avg30 » : la tendance pour une
 * série récente, la moyenne sur 30 jours ensuite), aux jours écrits AAAA-MM-JJ et aux prix
 * plausibles (`plausiblePrice`). Les versions (« Reverse Masterball ») et les variantes
 * (« Reverse ») sont d'autres prix : jamais mêlés. `null` sans historique.
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
  // Seulement un jour écrit AAAA-MM-JJ : une autre forme (une heure, un décalage) pourrait tomber
  // sur le jour d'à côté (`yearDay`), et le prix de ce jour-là serait remplacé.
  // Et seulement un prix plausible (`plausiblePrice`) : ni négatif, ni de 100 000 € ou plus.
  const points = history.points.flatMap(({ date, [series.id]: value }) => {
    const price = /^\d{4}-\d{2}-\d{2}$/.test(date) ? plausiblePrice(value) : null
    return price === null ? [] : [[date, price] as [string, number]]
  })
  return points.length ? points : null
}

/**
 * Les jours repris au plus avant le dernier relevé : Pokécardex en montre 180 ; un jour plus ancien
 * est une erreur de la source (une année fausse), qui écrirait loin dans l'historique.
 */
const HISTORY_DAYS = 200

/**
 * L'historique repris d'une carte (`mainHistory`) dans celui de son produit Cardmarket (testé) :
 * chaque jour avant `until` (le jour du dernier relevé de la tâche `prices`, qui garde le dernier
 * mot, lui et les suivants), et au plus 200 jours avant lui (`HISTORY_DAYS`), prend le prix
 * repris ; les autres restent tels quels. Puis son prix d'il y a 30 jours. Les années lues,
 * fusionnées et réécrites seulement si personne ne les a changées entre-temps (`writeYears`) :
 * sinon (la tâche `prices` y écrivait le prix du jour), relues et refaites. Rend le nombre de
 * jours changés ; `null` si aucun jour repris n'est dans ces bornes (rien à reprendre : la carte
 * compte comme une carte sans historique, `formatChanged`).
 */
export async function mergeHistory(cardmarket: number, points: readonly [string, number][]) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const until = (await readSource('cardmarket'))?.date ?? null
    const kept = points.filter(
      ([date]) => until === null || (date < until && date >= addDays(until, -HISTORY_DAYS)),
    )
    if (!kept.length) return null
    const years = new Set(kept.map(([date]) => yearDay(date)[0]))
    // Le prix d'il y a 30 jours lit aussi l'année du dernier relevé, et celle d'avant en janvier
    // (`monthAgoYears`).
    if (until) monthAgoYears(until).forEach((year) => years.add(year))
    const stored = await readYears([cardmarket], [...years])
    const merged = new Map<number, HistoryYear>(stored.map((row) => [row.year, row]))
    const changed = new Set<number>()
    let days = 0
    for (const [date, price] of kept) {
      const [year, day] = yearDay(date)
      const known = merged.get(year)
      const next = withPrice(known, year, day, price)
      if (next === known) continue
      merged.set(year, next)
      changed.add(year)
      days++
    }
    const writes = [...changed].map((year): YearWrite => {
      const { first, prices } = merged.get(year)!
      const old = stored.find((row) => row.year === year)?.text ?? null
      return { id: cardmarket, year, first, prices: JSON.stringify(prices), old }
    })
    if (writes.length && unwritten(writes, await env.DB.batch(writeYears(writes))).length) continue
    if (until) {
      await env.DB.prepare('UPDATE cardmarket_prices SET month_ago = ? WHERE id = ?')
        .bind(priceBefore([...merged.values()], until), cardmarket)
        .run()
    }
    return days
  }
  throw new Error(`Historique de ${cardmarket} changé sans cesse pendant sa reprise`)
}

/** Une carte à reprendre, et sa place dans l'ordre de la reprise. */
interface Todo {
  released: string
  lang: CardLanguage
  id: number
  cardmarket: number
}

/**
 * Les 50 cartes à reprendre après `after` (testé) : celles du catalogue avec un id Cardmarket,
 * absentes de `history_imports` pour leur langue (l'id 7091 de chaque langue est une autre carte),
 * les séries les plus récentes d'abord.
 */
export async function historyTodo(after: Todo | null) {
  const { results } = await env.DB.prepare(
    `SELECT sets.released, cards.lang, cards.id, cards.cardmarket
     FROM cards JOIN sets ON sets.lang = cards.lang AND sets.id = cards.set_id
     WHERE cards.cardmarket != 0 AND NOT EXISTS (
       SELECT 1 FROM history_imports WHERE lang = cards.lang AND card = cards.id)
       AND (?1 IS NULL OR sets.released < ?1
            OR (sets.released = ?1 AND (cards.lang, cards.id) > (?2, ?3)))
     ORDER BY sets.released DESC, cards.lang, cards.id LIMIT 50`,
  )
    .bind(after?.released ?? null, after?.lang ?? '', after?.id ?? 0)
    .all<Todo>()
  return results
}

/** Ce qu'une étape a repris. */
interface Batch {
  after: Todo | null
  read: number
  days: number
  failed: number
  /** Les pages en échec d'affilée, à la fin de l'étape. */
  inARow: number
  /**
   * Les pages lues des cartes dont le guide des prix donne un prix aujourd'hui et il y a 30 jours
   * (`checked`), et celles d'entre elles sans historique (`missing`) : `formatChanged`.
   */
  checked: number
  missing: number
}

/**
 * Le format des pages a sans doute changé (un champ renommé : `mainHistory` ne trouve plus rien) :
 * dans une étape, au moins 10 pages lues de cartes dont le guide des prix donne un prix aujourd'hui
 * et il y a 30 jours (`cardmarket_prices.month_ago`), et plus de la moitié sans historique.
 * Pokécardex relève ce guide chaque jour et en garde 180 jours : une telle carte a un historique
 * chez lui. Les autres ne comptent pas : sans vente depuis un mois (anciennes, rares) ou sorties
 * depuis peu, beaucoup n'en ont pas, et c'est normal.
 */
const formatChanged = ({ checked, missing }: Batch) => checked >= 10 && missing * 2 > checked

/**
 * Reprend l'historique de 50 cartes après `after`, puis note l'avancée (`sources` : `history`).
 * Une carte en échec n'est pas notée : relue au prochain passage. `inARow` : les pages en échec
 * d'affilée jusque-là ; à la 10e, l'étape s'arrête. Une carte lue sans historique n'est notée qu'en
 * fin d'étape, et seulement si le format des pages n'a pas changé (`formatChanged`) : sinon elle
 * serait notée lue sans que rien n'ait été lu, jamais relue, et les 180 jours que garde la source
 * perdus. Une page toutes les 3 s : plus de 2 min en tout, le signe de vie redit à chaque carte
 * (`alive`).
 */
async function historyBatch(after: Todo | null, inARow: number, alive: Alive): Promise<Batch> {
  const todo = await historyTodo(after)
  const batch: Batch = {
    after: todo.at(-1) ?? null,
    read: 0,
    days: 0,
    failed: 0,
    inARow,
    checked: 0,
    missing: 0,
  }
  // Les produits de ces cartes qui ont un prix aujourd'hui et il y a 30 jours (`formatChanged`).
  const { results } = await env.DB.prepare(
    `SELECT id FROM cardmarket_prices
     WHERE month_ago IS NOT NULL AND id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(todo.map((card) => card.cardmarket)))
    .all<{ id: number }>()
  const priced = new Set(results.map(({ id }) => id))
  const done = env.DB.prepare(
    'INSERT OR REPLACE INTO history_imports (lang, card, read_at) VALUES (?, ?, ?)',
  )
  const empty: Todo[] = []
  for (const card of todo) {
    await alive()
    try {
      const points = mainHistory(await readCard(card.lang, card.id), card.cardmarket)
      // `null` : sans historique, ou aucun de ses jours dans les bornes de la reprise.
      const days = points && (await mergeHistory(card.cardmarket, points))
      if (days === null) empty.push(card)
      else {
        batch.days += days
        await done.bind(card.lang, card.id, new Date().toISOString()).run()
      }
      if (priced.has(card.cardmarket)) {
        batch.checked++
        if (days === null) batch.missing++
      }
      batch.read++
      batch.inARow = 0
    } catch (error) {
      taskJournal('warn', 'Historique illisible', {
        langue: card.lang,
        carte: card.id,
        raison: reasonOf(error),
      })
      batch.failed++
      if (++batch.inARow >= MAX_FAILURES_IN_A_ROW) break
    }
  }
  const now = new Date().toISOString()
  if (!formatChanged(batch)) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO history_imports (lang, card, read_at)
       SELECT json_extract(value, '$.lang'), json_extract(value, '$.id'), ?2 FROM json_each(?1)`,
    )
      .bind(JSON.stringify(empty), now)
      .run()
  }
  await writeSource('history', { stamp: now, date: now.slice(0, 10) }).run()
  return batch
}

export async function history(step: Step) {
  let after: Todo | null = null
  let read = 0
  let days = 0
  let failed = 0
  let inARow = 0
  for (let page = 1; ; page++) {
    const from: Todo | null = after
    const pending = inARow
    const batch: Batch = await step(`cartes ${page}`, (alive) => historyBatch(from, pending, alive))
    read += batch.read
    days += batch.days
    failed += batch.failed
    inARow = batch.inARow
    if (inARow >= MAX_FAILURES_IN_A_ROW) {
      throw new Error(`${inARow} pages en échec d’affilée : la lecture s’arrête là`)
    }
    // Levée hors de l'étape : dans l'étape, l'erreur la ferait réessayer, ses 50 pages relues.
    if (formatChanged(batch)) {
      throw new Error(
        `Historique absent de ${batch.missing} pages sur ${batch.checked} de cartes au prix connu depuis un mois (format des pages changé ?)`,
      )
    }
    after = batch.after
    if (!after) break
  }
  // Le bilan dans sa propre étape, comme toute ligne du journal (`Step`). Des cartes isolées en
  // échec ne font pas échouer le passage (la tâche, à la demande, resterait sinon en échec jusqu'au
  // passage suivant) : rien n'est noté pour elles, le passage suivant, qui ne lit qu'elles et les
  // nouvelles, les relit ; le bilan le dit.
  await step('bilan', async () =>
    taskJournal(failed ? 'warn' : 'ok', 'Historique repris', {
      cartes: read,
      jours: days,
      enÉchec: failed || undefined,
    }),
  )
}
