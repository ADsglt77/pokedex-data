/**
 * Ce que partagent les fichiers de test du Worker : leurs requêtes SQL d'un seul tenant (`run`) et
 * le R2 vidé (`emptyFiles`), la D1 et le R2 d'un fichier étant partagés par ses tests.
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
