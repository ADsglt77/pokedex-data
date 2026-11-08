/**
 * Le schéma de la base des données (D1, `DB`), que remplissent les tâches d'ingestion (`ingest/`) ;
 * les réponses volumineuses et les images sont dans R2. Après une modification :
 * `bun run db:generate` en écrit la migration (`migrations/`).
 */

import { sql } from 'drizzle-orm'
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

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
 * Les séries du catalogue, dans chaque langue (un code se répète d'une langue à l'autre). Pour la
 * liste de souhaits : le nom de son extension chez Cardmarket (`expansion_name`), ce nom écrit comme
 * dans une adresse de Cardmarket (`expansion_slug`, `cardmarketSlug`), et l'extension commune des
 * adresses Cardmarket de ses cartes (`cardmarket_slug`) ; '' pour chacun s'il n'y en a pas.
 */
export const sets = sqliteTable(
  'sets',
  {
    lang: text().notNull(),
    id: text().notNull(),
    name: text().notNull(),
    released: text().notNull(),
    readAt: text('read_at').notNull(),
    logo: text(),
    logoChecked: text('logo_checked'),
    block: text(),
    blockRank: integer('block_rank'),
    deck: integer().notNull().default(0),
    expansionName: text('expansion_name').notNull().default(''),
    expansionSlug: text('expansion_slug').notNull().default(''),
    cardmarketSlug: text('cardmarket_slug').notNull().default(''),
  },
  (table) => [primaryKey({ columns: [table.lang, table.id] })],
)

/** Les cartes du catalogue, dans chaque langue. */
export const cards = sqliteTable(
  'cards',
  {
    lang: text().notNull(),
    id: integer().notNull(),
    setId: text('set_id').notNull(),
    number: text().notNull(),
    sort: integer().notNull(),
    name: text().notNull(),
    cardmarket: integer().notNull(),
    seen: text().notNull(),
    image: text(),
    imageChecked: text('image_checked'),
    rarity: integer(),
    type: integer(),
    printed: text().notNull().default(''),
    nameEn: text('name_en').notNull().default(''),
    nameDe: text('name_de').notNull().default(''),
    illustrator: text().notNull().default(''),
    versions: text().notNull().default('[]'),
  },
  (table) => [
    primaryKey({ columns: [table.lang, table.id] }),
    foreignKey({ columns: [table.lang, table.setId], foreignColumns: [sets.lang, sets.id] }),
    // Avec `sort` : le plus grand rang d'une série (`images.ts`) se lit dans l'index seul.
    index('cards_by_set').on(table.lang, table.setId, table.sort),
    index('cards_by_cardmarket').on(table.cardmarket),
  ],
)

/** Les Pokémon de chaque carte, dans l'ordre. */
export const cardSpecies = sqliteTable(
  'card_species',
  {
    lang: text().notNull(),
    card: integer().notNull(),
    rank: integer().notNull(),
    dexId: integer('dex_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.lang, table.card, table.rank] }),
    foreignKey({
      columns: [table.lang, table.card],
      foreignColumns: [cards.lang, cards.id],
    }).onDelete('cascade'),
  ],
)

/** Les raretés de chaque langue. */
export const rarities = sqliteTable(
  'rarities',
  {
    lang: text().notNull(),
    id: integer().notNull(),
    name: text().notNull(),
    rank: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.lang, table.id] })],
)

/** Les cartes dont l'historique de Pokécardex a été repris (tâche `history`). */
export const historyImports = sqliteTable(
  'history_imports',
  {
    lang: text().notNull(),
    card: integer().notNull(),
    readAt: text('read_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.lang, table.card] })],
)
