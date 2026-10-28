/**
 * Ce qu'on a lu de chaque source à son dernier passage (`sources`) : `stamp`, sa date de mise à
 * jour (pour ne pas la retélécharger si elle n'a pas changé), et `date`, le jour de ses données.
 * `cardmarket` : le guide des prix (tâche `prices`) ; `history` : l'avancée de la reprise de
 * l'historique (tâche `history`). Les deux font l'ETag des réponses tirées des prix.
 */

import { env } from 'cloudflare:workers'

interface Source {
  stamp: string
  date: string
}

export const readSource = (name: string) =>
  env.DB.prepare('SELECT stamp, date FROM sources WHERE name = ?').bind(name).first<Source>()

/** La requête qui note le passage (`run()`, ou dans un `batch` avec ce qu'il a écrit). */
export const writeSource = (name: string, { stamp, date }: Source) =>
  env.DB.prepare(
    `INSERT INTO sources (name, stamp, date) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, date = excluded.date`,
  ).bind(name, stamp, date)
