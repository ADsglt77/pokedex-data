/**
 * Les passages des tâches d'ingestion (table `runs`) : notés par `ingest.ts`, lus par `status.ts`.
 * Un passage en cours donne signe de vie chaque minute (`alive_at`). Sans signe de vie depuis
 * 5 min, son processus a été arrêté net (conteneur tué, mémoire épuisée, machine redémarrée) : il
 * ne tourne plus, même si rien n'a pu noter sa fin.
 */

import type { Database } from 'bun:sqlite'
import type { IngestJob } from '@/config/jobs'
import { MINUTE } from '@/lib/time'

/** Un signe de vie chaque minute ; 5 manqués, et le passage est tenu pour arrêté. */
const BEAT = MINUTE
const STALE = 5 * MINUTE

/** Le plus ancien signe de vie d'un passage encore en cours, à `now` (ms). */
export const aliveSince = (now: number) => new Date(now - STALE).toISOString()

/**
 * Commence un passage de `job` : son id, ou `null` si la tâche tourne déjà dans un autre processus
 * (un passage ouvert, en vie : deux à la fois doubleraient le rythme des requêtes). Un passage
 * ouvert sans signe de vie est noté interrompu, terminé à son dernier signe de vie. En une
 * transaction : deux processus lancés ensemble ne commencent pas tous deux.
 */
export function startRun(db: Database, job: IngestJob, now = Date.now()) {
  return db
    .transaction(() => {
      const running = db
        .query('SELECT 1 FROM runs WHERE job = ? AND finished_at IS NULL AND alive_at >= ?')
        .get(job, aliveSince(now))
      if (running) return null
      db.query(
        `UPDATE runs SET finished_at = alive_at, ok = 0, message = 'interrompue'
         WHERE job = ? AND finished_at IS NULL`,
      ).run(job)
      const at = new Date(now).toISOString()
      const { id } = db
        .query('INSERT INTO runs (job, started_at, alive_at) VALUES (?, ?, ?) RETURNING id')
        .get(job, at, at) as { id: number }
      return id
    })
    .immediate()
}

/** Note la fin d'un passage : réussi, ou la cause de son échec (« interrompue » s'il est arrêté). */
export function finishRun(db: Database, id: number, ok: boolean, message: string | null) {
  db.query('UPDATE runs SET finished_at = ?, ok = ?, message = ? WHERE id = ?').run(
    new Date().toISOString(),
    ok ? 1 : 0,
    message,
    id,
  )
}

/**
 * Le signe de vie d'un passage, chaque minute, jusqu'à l'appel de la fonction rendue. Un signe
 * manqué (la base occupée plus de 5 s par la longue écriture d'un autre processus) n'arrête pas la
 * tâche : le suivant le donne.
 */
export function keepAlive(db: Database, id: number) {
  const beat = db.query('UPDATE runs SET alive_at = ? WHERE id = ?')
  const timer = setInterval(() => {
    try {
      beat.run(new Date().toISOString(), id)
    } catch {
      // Le suivant, dans une minute.
    }
  }, BEAT)
  return () => clearInterval(timer)
}
