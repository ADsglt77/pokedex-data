/**
 * L'historique des prix Cardmarket (Cardmarket n'en garde pas) : en base, un tableau par carte et
 * par année, à partir de son premier jour avec un prix ; pour l'app, la forme de toujours
 * (`CardPriceHistory`) : un prix par jour depuis le premier jour où la carte en a un. Le relevé
 * quotidien l'écrit (`jobs/prices.ts`), la reprise de Pokécardex le complète (`mergePrices`,
 * `jobs/history.ts`).
 */

import type { Database } from 'bun:sqlite'
import { addDays, DAY, daysBetween } from '@/lib/time'
import type { CardPriceHistory } from '@/contract'

/** `2026-10-14` → [2026, 286] : l'année et le jour de l'année (0 : 1er janvier). */
export function yearDay(date: string): [number, number] {
  const year = Number(date.slice(0, 4))
  return [year, (Date.parse(date) - Date.UTC(year, 0, 1)) / DAY]
}

/** Une année d'historique, telle qu'enregistrée : les prix à partir du jour de l'année `first`. */
export interface HistoryYear {
  year: number
  first: number
  prices: (number | null)[]
}

/**
 * L'année `year` avec le prix du jour `day` : `known` (l'année enregistrée) si elle l'avait déjà,
 * rien à réécrire ; sinon une copie, ou une nouvelle année sans `known`.
 */
export function withPrice(
  known: HistoryYear | undefined,
  year: number,
  day: number,
  price: number,
): HistoryYear {
  if (!known) return { year, first: day, prices: [price] }
  if (known.prices[day - known.first] === price) return known
  const first = Math.min(known.first, day)
  const prices = [...Array<null>(known.first - first).fill(null), ...known.prices]
  while (prices.length < day - first) prices.push(null)
  prices[day - first] = price
  return { year, first, prices }
}

/** Le prix d'il y a un mois (`monthAgo`) : celui d'il y a 30 jours. */
const MONTH_AGO = 30

/**
 * Le prix d'il y a 30 jours avant `date` dans ces années, ou, ce jour-là sans prix, celui du jour
 * le plus proche avant lui, une semaine plus tôt au plus ; `null` sans.
 */
export function priceBefore(years: HistoryYear[], date: string): number | null {
  for (let back = MONTH_AGO; back <= MONTH_AGO + 7; back++) {
    const [year, day] = yearDay(addDays(date, -back))
    const row = years.find((known) => known.year === year)
    const price = row?.prices[day - row.first]
    if (typeof price === 'number') return price
  }
  return null
}

/**
 * L'historique en base, carte par carte et année par année, requêtes préparées une fois : lire
 * l'année d'une carte (`undefined` sans), l'enregistrer, et son prix d'il y a 30 jours.
 */
export function historyStore(db: Database) {
  const read = db.query('SELECT first, prices FROM cardmarket_history WHERE id = ? AND year = ?')
  const write = db.query(
    `INSERT INTO cardmarket_history (id, year, first, prices) VALUES (?, ?, ?, ?)
     ON CONFLICT (id, year) DO UPDATE SET first = excluded.first, prices = excluded.prices`,
  )
  return {
    year(id: number, year: number): HistoryYear | undefined {
      const row = read.get(id, year) as { first: number; prices: string } | null
      return row ? { year, first: row.first, prices: JSON.parse(row.prices) } : undefined
    },
    save(id: number, { year, first, prices }: HistoryYear) {
      write.run(id, year, first, JSON.stringify(prices))
    },
    /** Le prix d'il y a 30 jours de la carte `id`, avant `date` (en janvier, l'année d'avant aussi). */
    monthAgo(id: number, date: string) {
      const years = new Set([yearDay(addDays(date, -37))[0], yearDay(date)[0]])
      return priceBefore(
        [...years].flatMap((year) => this.year(id, year) ?? []),
        date,
      )
    },
  }
}

/**
 * Des prix repris d'ailleurs (`[jour, prix]` : l'historique de Pokécardex, `jobs/history.ts`) dans
 * l'historique de la carte `id` : chaque jour avant `until` (le jour du dernier relevé, qui garde
 * le dernier mot, lui et les suivants) prend le prix repris ; les autres jours restent tels quels.
 * Les années lues, fusionnées et réécrites en une transaction `IMMEDIATE` (une étape de celle qui
 * l'appelle, `mergeHistory`) : chaque année est réécrite entière, et lue avant le relevé du jour
 * qu'un autre processus écrit (la tâche `prices`), elle l'effacerait. Rend le nombre de jours
 * changés.
 */
export function mergePrices(
  db: Database,
  id: number,
  points: readonly [date: string, price: number][],
  until: string | null,
) {
  return db
    .transaction(() => {
      const store = historyStore(db)
      const years = new Map<number, HistoryYear | undefined>()
      const changed = new Set<number>()
      let days = 0
      for (const [date, price] of points) {
        if (until !== null && date >= until) continue
        const [year, day] = yearDay(date)
        if (!years.has(year)) years.set(year, store.year(id, year))
        const known = years.get(year)
        const next = withPrice(known, year, day, price)
        if (next === known) continue
        years.set(year, next)
        changed.add(year)
        days++
      }
      for (const year of changed) store.save(id, years.get(year)!)
      return days
    })
    .immediate()
}

/**
 * Les années, dans l'ordre, mises bout à bout : un prix par jour, du premier au dernier prix ;
 * `null` si aucune n'en a.
 */
export function joinYears(years: HistoryYear[]): Pick<CardPriceHistory, 'from' | 'prices'> | null {
  const [head] = years
  if (!head) return null
  const from = addDays(`${head.year}-01-01`, head.first)
  const prices: (number | null)[] = []
  for (const { year, first, prices: list } of years) {
    // Les jours sans prix entre deux années restent `null`.
    const offset = daysBetween(from, addDays(`${year}-01-01`, first))
    while (prices.length < offset) prices.push(null)
    prices.push(...list)
  }
  return { from, prices }
}

/**
 * La lecture de l'historique d'une carte Cardmarket, requête préparée une fois (l'API en lit
 * jusqu'à 1 025 par demande) : `null` si elle n'en a pas.
 */
export function historyReader(db: Database) {
  // Chaque année de la carte, avec son nom chez Cardmarket (vide hors de la liste des produits).
  const years = db.query(
    `SELECT history.year, history.first, history.prices, products.name
     FROM cardmarket_history AS history
     LEFT JOIN cardmarket_products AS products ON products.id = history.id
     WHERE history.id = ? ORDER BY history.year`,
  )
  return (id: number): CardPriceHistory | null => {
    const rows = years.all(id) as {
      year: number
      first: number
      prices: string
      name: string | null
    }[]
    const joined = joinYears(
      rows.map(({ year, first, prices }) => ({ year, first, prices: JSON.parse(prices) })),
    )
    return joined && { name: rows[0]!.name, ...joined }
  }
}
