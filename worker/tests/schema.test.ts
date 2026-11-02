/**
 * Le schéma : aucune reconstruction de table écrite par Drizzle ne part telle quelle. Pour la
 * plupart des changements de colonne, il reconstruit la table (`PRAGMA foreign_keys=OFF`,
 * `__new_…`, puis `DROP TABLE`) ; sur D1, ce PRAGMA ne fait rien, et la suppression emporte en
 * cascade ce qui en dépend (reconstruire `cards` viderait `card_species`). Réécrite à la main
 * (`CLAUDE.md`, « Le schéma »), une telle migration porte en tête `-- reconstruction vérifiée`.
 * Les migrations lues par la configuration (`env.MIGRATIONS`) : le moteur de Cloudflare n'a pas
 * de fichiers.
 */

import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'

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
