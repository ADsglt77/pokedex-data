/**
 * Le schéma : aucune reconstruction de table écrite par Drizzle ne part telle quelle. Pour la
 * plupart des changements de colonne, il reconstruit la table (`PRAGMA foreign_keys=OFF`,
 * `__new_…`, puis `DROP TABLE`) ; sur D1, ce PRAGMA ne fait rien, et la suppression emporte en
 * cascade ce qui en dépend. Réécrite à la main (`CLAUDE.md`, « Le schéma »), une telle migration
 * porte en tête `-- reconstruction vérifiée`. Et le retrait du catalogue de Pokécardex (migrations
 * `0004` et `0005`), sur une base remplie comme en ligne : ses tables retirées (celles qui en
 * référencent d'autres d'abord : sinon D1 refuse), les prix et leur historique (irremplaçable)
 * gardés tels quels. Les migrations lues par la configuration (`env.MIGRATIONS`) : le moteur de
 * Cloudflare n'a pas de fichiers.
 */

import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { rows, run } from './helpers'

/** Les migrations qui coupent les clés étrangères sans être marquées vérifiées. */
const unchecked = (migrations: D1Migration[]) =>
  migrations
    .filter(({ queries }) => {
      const sql = queries.join('\n')
      return (
        /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql) && !sql.includes('-- reconstruction vérifiée')
      )
    })
    .map(({ name }) => name)

test('aucune migration ne reconstruit une table sans être vérifiée', () => {
  // La forme qu'écrit Drizzle : refusée, sauf marquée.
  const generated = ['PRAGMA foreign_keys=OFF', '--> statement-breakpoint\nDROP TABLE `cards`']
  const checked = ['-- reconstruction vérifiée\nPRAGMA foreign_keys=OFF', ...generated.slice(1)]
  expect(
    unchecked([
      { name: '0002_generee.sql', queries: generated },
      { name: '0003_verifiee.sql', queries: checked },
    ]),
  ).toEqual(['0002_generee.sql'])
  expect(unchecked(env.MIGRATIONS)).toEqual([])
})

/** Les tables de la base, sans celles de SQLite et de Cloudflare. */
const tables = async () =>
  (
    await rows(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
  ).map(({ name }) => name as string)

test('le retrait du catalogue de Pokécardex, sur une base remplie : ses tables retirées, les prix et leur historique gardés', async () => {
  // La base vidée de toutes ses tables (celle de ce fichier seulement), puis migrée jusqu'à la
  // dernière migration d'avant le retrait, comme en ligne le 13 novembre 2026.
  for (const name of await tables()) await env.DB.prepare(`DROP TABLE "${name}"`).run()
  const before = env.MIGRATIONS.findIndex(({ name }) => name.startsWith('0004_'))
  await applyD1Migrations(env.DB, env.MIGRATIONS.slice(0, before))
  await run(
    "INSERT INTO sets (lang, id, name, released, read_at) VALUES ('ja', 'SV2A', '151', '2023-06-16', '2026-11-01')",
    `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
     VALUES ('ja', 7091, 'SV2A', '168', 168, 'Salamèche', 719621, '2026-11-01')`,
    "INSERT INTO card_species (lang, card, rank, dex_id) VALUES ('ja', 7091, 0, 4)",
    "INSERT INTO rarities (lang, id, name, rank) VALUES ('ja', 48, 'AR', 5)",
    "INSERT INTO history_imports (lang, card, read_at) VALUES ('ja', 7091, '2026-11-01')",
    "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (719621, 2026, 254, '[5,6.5]')",
    'INSERT INTO cardmarket_prices (id, price, low, month_ago) VALUES (719621, 6.5, 5, null)',
    "INSERT INTO cardmarket_products (id, name, expansion, metacard) VALUES (719621, 'Charmander', 5011, 77)",
    "INSERT INTO sources (name, stamp, date) VALUES ('cardmarket', 'lundi', '2026-11-12'), ('history', '3', '2026-11-01')",
    "INSERT INTO runs (job, started_at, finished_at, ok) VALUES ('history', '2026-11-01', '2026-11-02', 1)",
  )
  await applyD1Migrations(env.DB, env.MIGRATIONS)
  expect(await tables()).toEqual([
    'cardmarket_history',
    'cardmarket_prices',
    'cardmarket_prices_next',
    'cardmarket_products',
    'catalog_cards',
    'd1_migrations',
    'runs',
    'sources',
  ])
  expect(await rows('SELECT * FROM cardmarket_history')).toEqual([
    { id: 719621, year: 2026, first: 254, prices: '[5,6.5]' },
  ])
  expect(await rows('SELECT id, price FROM cardmarket_prices')).toEqual([
    { id: 719621, price: 6.5 },
  ])
  expect(await rows('SELECT id FROM cardmarket_products')).toEqual([{ id: 719621 }])
  expect(await rows('SELECT name FROM sources')).toEqual([{ name: 'cardmarket' }])
  expect(await rows('SELECT job FROM runs')).toEqual([{ job: 'history' }])
  expect(await rows('SELECT * FROM catalog_cards')).toEqual([])
})
