/**
 * Où en sont les tâches d'ingestion, d'après leurs passages (`runs`, notés par `ingest.ts`) :
 * - `GET /v1/status` : chaque tâche, son rythme, son état et ses dates, et le jour des prix en base
 *   (la page Données du site le montre) ; la cause d'un échec reste dans le journal de l'ingestion ;
 * - `GET /v1/health`, sans token : pour une surveillance (UptimeRobot…), 200 si chaque tâche à
 *   rythme a réussi récemment (deux intervalles au plus) et que les prix ne sont pas figés, 503
 *   sinon, avec les tâches en retard. Les tâches à la demande n'y comptent pas.
 */

import type { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import { INGEST_JOB_NAMES, INGEST_JOBS, type IngestJob } from '@/config/jobs'
import type { JobState, ServerStatus } from '@/contract'
import { DAY } from '@/lib/time'
import { readSource } from './db'

interface Runs {
  lastSuccess: string | null
  lastRun: string | null
}

/**
 * Deux intervalles sans réussite (ou jamais réussie) : l'ingestion ne la relance plus (service
 * arrêté ?), ou elle échoue sans cesse. Une tâche à la demande n'est jamais en retard. `now` : en ms.
 */
const overdue = (job: IngestJob, lastSuccess: string | null, now: number) => {
  const { every } = INGEST_JOBS[job]
  return every !== null && (lastSuccess === null || now - Date.parse(lastSuccess) > 2 * every)
}

/**
 * Le guide des prix en base (`pricesDate`, son jour) a plus de deux jours : la tâche réussit, mais
 * Cardmarket ne le régénère plus (« inchangé » à chaque passage). Chaque jour sans prix est un trou
 * dans l'historique, qui ne se rattrape jamais. `now` : en ms.
 */
const pricesFrozen = (pricesDate: string | null, now: number) =>
  pricesDate !== null && now - Date.parse(pricesDate) > 2 * DAY

function stateOf(job: IngestJob, runs: Runs | undefined, pricesDate: string | null, now: number) {
  let state: JobState = 'ok'
  if (!runs?.lastRun) state = 'never'
  else if (runs.lastRun !== runs.lastSuccess) state = 'failed'
  else if (overdue(job, runs.lastSuccess, now)) state = 'late'
  else if (job === 'prices' && pricesFrozen(pricesDate, now)) state = 'frozen'
  return state
}

/** Les passages de chaque tâche et le jour des prix, lus à chaque demande. */
function reader(data: Database) {
  const runs = data.query(
    `SELECT job, MAX(CASE WHEN ok = 1 THEN finished_at END) AS lastSuccess,
            MAX(finished_at) AS lastRun
     FROM runs GROUP BY job`,
  )
  return () => ({
    runs: new Map((runs.all() as ({ job: string } & Runs)[]).map(({ job, ...row }) => [job, row])),
    pricesDate: readSource(data, 'cardmarket')?.date ?? null,
    now: Date.now(),
  })
}

export function statusRoutes(data: Database) {
  const read = reader(data)
  return new Elysia({ name: 'status' })
    .get(
      '/status',
      ({ set }): ServerStatus => {
        set.headers['cache-control'] = 'no-cache'
        const { runs, pricesDate, now } = read()
        return {
          jobs: INGEST_JOB_NAMES.map((job) => ({
            job,
            label: INGEST_JOBS[job].label,
            every: INGEST_JOBS[job].every,
            state: stateOf(job, runs.get(job), pricesDate, now),
            lastSuccess: runs.get(job)?.lastSuccess ?? null,
            lastRun: runs.get(job)?.lastRun ?? null,
          })),
          pricesDate,
        }
      },
      { detail: { summary: 'Les tâches d’ingestion', tags: ['État'] } },
    )
    .get(
      // Sans token (`auth.ts`) : seulement 200 ou 503, et les tâches en retard.
      '/health',
      ({ set }) => {
        set.headers['cache-control'] = 'no-store'
        const { runs, pricesDate, now } = read()
        const late = INGEST_JOB_NAMES.filter(
          (job) =>
            overdue(job, runs.get(job)?.lastSuccess ?? null, now) ||
            (job === 'prices' && pricesFrozen(pricesDate, now)),
        )
        if (late.length > 0) set.status = 503
        return { ok: late.length === 0, late }
      },
      {
        detail: {
          summary: 'Pour une surveillance : 503 si une tâche est en retard',
          tags: ['État'],
        },
      },
    )
}
