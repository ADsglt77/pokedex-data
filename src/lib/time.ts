/** Les durées en millisecondes, et le calcul des jours (YYYY-MM-DD, en temps universel). */

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY

/** Le jour `days` jours après `date` : `addDays('2026-12-31', 1)` → `2027-01-01`. */
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10)

/** Le nombre de jours de `from` à `to`. */
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY)
