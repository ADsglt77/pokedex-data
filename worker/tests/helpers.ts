/**
 * Ce que partagent les fichiers de test du Worker : leurs requêtes SQL d'un seul tenant (`run`),
 * leurs lignes lues (`rows`), le catalogue vidé (`emptyCatalog`) et le R2 vidé (`emptyFiles`), la
 * D1 et le R2 d'un fichier étant partagés par ses tests.
 */

import { env } from 'cloudflare:workers'

/** Des requêtes SQL, d'un seul tenant : chacune, une chaîne ou `[requête, ...paramètres]`. */
export const run = (...statements: (string | [string, ...unknown[]])[]) =>
  env.DB.batch(
    statements.map((statement) =>
      typeof statement === 'string'
        ? env.DB.prepare(statement)
        : env.DB.prepare(statement[0]).bind(...statement.slice(1)),
    ),
  )

/** Les lignes que rend une requête SQL. */
export const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results

/** Un catalogue vide : ni carte, ni série, ni rareté (dans l'ordre de leurs clés étrangères). */
export const emptyCatalog = () =>
  run('DELETE FROM card_species', 'DELETE FROM cards', 'DELETE FROM sets', 'DELETE FROM rarities')

/** Aucune image ni réponse enregistrée dans R2. */
export async function emptyFiles() {
  for (
    let listed = await env.FILES.list();
    listed.objects.length;
    listed = await env.FILES.list()
  ) {
    await env.FILES.delete(listed.objects.map(({ key }) => key))
  }
}
