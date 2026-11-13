/**
 * Ce que partagent les fichiers de test du Worker : leurs requêtes SQL d'un seul tenant (`run`,
 * dans la D1 du Worker ou celle de l'importateur), leurs lignes lues (`rows`), le catalogue vidé
 * (`emptyCatalog`) et le R2 vidé (`emptyFiles`), la D1 et le R2 d'un fichier étant partagés par ses
 * tests ; le signe de vie des étapes (`alive`).
 */

import { env } from 'cloudflare:workers'

/** Une requête SQL : une chaîne, ou `[requête, ...paramètres]`. */
type Statement = string | [string, ...unknown[]]

/** Des requêtes SQL dans la base `db`, d'un seul tenant. */
const runIn = (db: D1Database, statements: Statement[]) =>
  db.batch(
    statements.map((statement) =>
      typeof statement === 'string'
        ? db.prepare(statement)
        : db.prepare(statement[0]).bind(...statement.slice(1)),
    ),
  )

/** Des requêtes SQL dans la D1 du Worker, d'un seul tenant. */
export const run = (...statements: Statement[]) => runIn(env.DB, statements)

/** Des requêtes SQL dans la base de l'importateur (`CARDS`), d'un seul tenant. */
export const runCards = (...statements: Statement[]) => runIn(env.CARDS, statements)

/** Les lignes que rend une requête SQL. */
export const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results

/**
 * Un catalogue vide : ni carte, ni série dans la base de l'importateur (dans l'ordre de leurs clés
 * étrangères), ni ligne dans le miroir.
 */
export const emptyCatalog = async () => {
  await runCards('DELETE FROM cards', 'DELETE FROM sets', 'DELETE FROM series')
  await run('DELETE FROM catalog_cards')
}

/** Le signe de vie d'une étape (`Alive`), hors d'un passage : rien à noter. */
export const alive = async () => {}

/** Aucune image ni réponse enregistrée dans les R2 (le nôtre, celui de l'importateur). */
export async function emptyFiles() {
  for (const bucket of [env.FILES, env.IMPORTS]) {
    for (let listed = await bucket.list(); listed.objects.length; listed = await bucket.list()) {
      await bucket.delete(listed.objects.map(({ key }) => key))
    }
  }
}
