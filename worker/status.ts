/**
 * Où en sont les tâches d'ingestion, d'après leurs passages (`runs`, `ingest/runs.ts`) :
 * - `GET /v1/status` : l'identité et l'état de chaque tâche (le site n'affiche que les problèmes) ;
 *   la cause d'un échec reste dans le journal du Worker ; un passage arrêté net (sans signe de vie,
 *   `aliveSince`) est un échec ;
 * - `GET /v1/health`, sans token : pour une surveillance (UptimeRobot…), 200 si chaque tâche à
 *   rythme (les espèces, le catalogue, les prix) a réussi récemment (deux intervalles au plus) et
 *   que les prix ne sont pas figés, 503 sinon, avec les tâches en retard.
 * Dans les deux, une tâche dont une sortie manque dans R2 (`missingOutputs` : une réponse effacée)
 * est en retard, même à la demande (`sprites`) ou à jour d'après ses passages.
 */

import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { aliveSince, INGEST_JOB_NAMES, INGEST_JOBS, type IngestJob } from '@/config/jobs'
import type { ServerStatus } from '@/contract'
import { missingOutputs } from './ingest/runs'
import { DAY } from '@/lib/time'

interface Runs {
  lastSuccess: string | null
  lastRun: string | null
}

/**
 * Deux intervalles sans réussite (ou jamais réussie) : le Cron ne la relance plus, ou elle échoue
 * sans cesse. Une tâche à la demande n'est jamais en retard. `now` : en ms.
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

/**
 * L'état d'une tâche. Une sortie absente de R2 (`missingOutputs`) la met en retard, même à jour
 * d'après ses passages ou jamais passée : ce qu'elle sert répond 404.
 */
function stateOf(
  job: IngestJob,
  runs: Runs | undefined,
  missing: boolean,
  pricesDate: string | null,
  now: number,
) {
  if (!runs?.lastRun) return missing || INGEST_JOBS[job].every !== null ? 'late' : 'never'
  if (runs.lastRun !== runs.lastSuccess) return 'failed'
  if (missing || overdue(job, runs.lastSuccess, now)) return 'late'
  if (job === 'prices' && pricesFrozen(pricesDate, now)) return 'frozen'
  return 'ok'
}

/**
 * Les passages de chaque tâche et le jour des prix, lus à chaque demande, ensemble. Un passage en
 * cours ne compte pas encore (l'état reste celui du passage d'avant) ; un passage ouvert sans signe
 * de vie, arrêté net, compte comme un échec, terminé à son dernier signe de vie.
 */
async function read() {
  const now = Date.now()
  const [runs, prices] = await env.DB.batch([
    env.DB.prepare(
      `SELECT job, MAX(CASE WHEN ok = 1 THEN finished_at END) AS lastSuccess,
              MAX(COALESCE(finished_at, CASE WHEN alive_at < ? THEN alive_at END)) AS lastRun
       FROM runs GROUP BY job`,
    ).bind(aliveSince(now)),
    env.DB.prepare("SELECT date FROM sources WHERE name = 'cardmarket'"),
  ])
  const rows = runs!.results as ({ job: string } & Runs)[]
  return {
    runs: new Map(rows.map(({ job, ...row }) => [job, row])),
    missing: await missingOutputs(),
    pricesDate: (prices!.results[0] as { date: string } | undefined)?.date ?? null,
    now,
  }
}

export const statusRoutes = new Hono()
  .get('/status', async (c) => {
    const { runs, missing, pricesDate, now } = await read()
    c.header('Cache-Control', 'no-cache')
    return c.json<ServerStatus>({
      jobs: INGEST_JOB_NAMES.map((job) => ({
        job,
        label: INGEST_JOBS[job].label,
        state: stateOf(job, runs.get(job), missing.has(job), pricesDate, now),
      })),
    })
  })
  // Sans token (`auth.ts`) : seulement 200 ou 503, et les tâches en retard.
  .get('/health', async (c) => {
    const { runs, missing, pricesDate, now } = await read()
    const late = INGEST_JOB_NAMES.filter(
      (job) =>
        missing.has(job) ||
        overdue(job, runs.get(job)?.lastSuccess ?? null, now) ||
        (job === 'prices' && pricesFrozen(pricesDate, now)),
    )
    c.header('Cache-Control', 'no-store')
    return c.json({ ok: late.length === 0, late }, late.length > 0 ? 503 : 200)
  })
