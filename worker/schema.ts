/**
 * Le schéma de la base des données (D1, `DB`), que remplissent les tâches d'ingestion (`ingest/`) ;
 * les réponses volumineuses et les images sont dans R2. Après une modification :
 * `bun run db:generate` en écrit la migration (`migrations/`).
 */

import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Ce qu'on a lu de chaque source à son dernier passage : sa date de mise à jour, son jour. */
export const sources = sqliteTable('sources', {
  name: text().primaryKey(),
  stamp: text().notNull(),
  date: text().notNull(),
})

/**
 * Les passages des tâches : `ok` et `finished_at` restent nuls tant qu'elle tourne. `runs_open` :
 * les seuls passages ouverts, que cherche `startRun` sans relire tous ceux de la tâche.
 */
export const runs = sqliteTable(
  'runs',
  {
    id: integer().primaryKey(),
    job: text().notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    ok: integer(),
    message: text(),
    aliveAt: text('alive_at'),
  },
  (table) => [
    index('runs_by_job').on(table.job, table.id),
    index('runs_open')
      .on(table.job)
      .where(sql`finished_at IS NULL`),
  ],
)

/**
 * Les colonnes des prix du jour, les mêmes dans les deux tables : la tâche `prices` copie l'une
 * dans l'autre, colonne par colonne.
 */
const priceColumns = () => ({
  id: integer().primaryKey(),
  price: real().notNull(),
  low: real(),
  monthAgo: real('month_ago'),
})

/** Le prix du jour de chaque carte Cardmarket, par id produit, et celui d'il y a 30 jours. */
export const cardmarketPrices = sqliteTable('cardmarket_prices', priceColumns())

/**
 * Les prix du jour en cours d'écriture par la tâche `prices`, qui remplacent ceux de
 * `cardmarket_prices` d'un seul tenant, une fois tous écrits (`prices.ts`).
 */
export const cardmarketPricesNext = sqliteTable('cardmarket_prices_next', priceColumns())

/** Chaque produit Cardmarket : son nom, son extension et sa métacarte (la liste de souhaits). */
export const cardmarketProducts = sqliteTable(
  'cardmarket_products',
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    expansion: integer(),
    metacard: integer(),
  },
  (table) => [index('cardmarket_products_by_card').on(table.expansion, table.metacard)],
)

/**
 * L'historique : un prix par jour (`null` sans prix), un tableau JSON par carte et par année, à
 * partir du jour de l'année `first` (0 : 1er janvier).
 */
export const cardmarketHistory = sqliteTable(
  'cardmarket_history',
  {
    id: integer().notNull(),
    year: integer().notNull(),
    first: integer().notNull(),
    prices: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.year] })],
)

/**
 * Le miroir du catalogue, que tient la tâche `catalog` d'après la base de l'importateur : chaque
 * carte de chaque langue, par sa série (l'id de TCGdex) et son numéro (`localId`), avec son id
 * Cardmarket (0 : aucun) et la sortie de sa série dans sa langue (YYYY-MM-DD, '' si inconnue). Ce
 * que lit la tâche `prices` : le prix d'une carte d'une série récente est sa tendance.
 */
export const catalogCards = sqliteTable(
  'catalog_cards',
  {
    lang: text().notNull(),
    setId: text('set_id').notNull(),
    number: text().notNull(),
    cardmarket: integer().notNull(),
    released: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.lang, table.setId, table.number] }),
    index('catalog_cards_by_released').on(table.released),
  ],
)
