/**
 * L'historique des prix, tel que l'écrivent les tâches et le lit l'API (`history.ts`, et
 * `worker/history.ts`) : un tableau par carte et par année, à partir de son premier jour avec un
 * prix ; pour l'app, un prix par jour depuis ce premier jour (`joinYears`). Sans base : commun à
 * l'ingestion et au Worker.
 */

import type { CardPriceHistory } from '@/contract'
import { addDays, DAY, daysBetween } from '@/lib/time'

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
