/**
 * L'historique des prix, tel que l'écrivent les tâches et le lit l'API (`worker/ingest/prices.ts`,
 * `worker/ingest/history.ts`, et `worker/history.ts`) : un tableau par carte et par année, à partir
 * de son premier jour avec un prix ; pour l'app, un prix par jour depuis ce premier jour
 * (`joinYears`, assemblé en texte). Chaque prix plausible et au centime (`plausiblePrice`), celui
 * du jour comme celui repris. Sans base : commun aux tâches et à l'API.
 */

import type { CardPriceHistory } from '@/contract'
import { addDays, daysBetween } from '@/lib/time'

/** Au-delà, une valeur des sources n'est pas un prix de carte (une erreur, un format changé). */
const MAX_PRICE = 100_000

/**
 * Une valeur des sources lue comme un prix, la même règle pour le prix du jour et pour l'historique
 * repris (testé) : un nombre qui, au centime, fait plus de 0 et moins de 100 000 € ; sinon `null`
 * (Cardmarket note `0` ou `null` un prix inconnu).
 */
export function plausiblePrice(value: unknown) {
  if (typeof value !== 'number') return null
  const cents = Math.round(value * 100) / 100
  return cents > 0 && cents < MAX_PRICE ? cents : null
}

/** `2026-10-14` → [2026, 286] : l'année et le jour de l'année (0 : 1er janvier). */
export function yearDay(date: string): [number, number] {
  const year = Number(date.slice(0, 4))
  return [year, daysBetween(`${year}-01-01`, date)]
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

/** Les années que lit `priceBefore(…, date)`, et celle de `date`. */
export const monthAgoYears = (date: string) => [
  ...new Set([yearDay(addDays(date, -(MONTH_AGO + 7)))[0], yearDay(date)[0]]),
]

/**
 * Une année telle qu'en base : ses prix en texte JSON compact (`[6.87,null,7.1]`), et leur nombre
 * (`length`).
 */
export interface StoredYear {
  year: number
  first: number
  prices: string
  length: number
}

/**
 * Les années, dans l'ordre, mises bout à bout sans les relire : le premier jour, et le texte JSON
 * d'un prix par jour du premier au dernier prix (`CardPriceHistory`) ; `null` sans année. Les prix
 * de chaque année tels qu'en base, et un `null` par jour sans prix entre deux années : relus puis
 * réécrits, 1 000 cartes sur un an prendraient environ 90 ms (testé contre les années relues).
 */
export function joinYears(
  years: StoredYear[],
): (Pick<CardPriceHistory, 'from'> & { prices: string }) | null {
  const [head] = years
  if (!head) return null
  const from = addDays(`${head.year}-01-01`, head.first)
  const parts: string[] = []
  let days = 0
  for (const { year, first, prices, length } of years) {
    // Les jours sans prix entre deux années restent `null`.
    const gap = Math.max(0, daysBetween(from, addDays(`${year}-01-01`, first)) - days)
    if (gap) parts.push(Array<string>(gap).fill('null').join())
    if (length) parts.push(prices.slice(1, -1))
    days += gap + length
  }
  return { from, prices: `[${parts.join()}]` }
}
