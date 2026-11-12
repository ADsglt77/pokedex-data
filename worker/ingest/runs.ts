/**
 * Les passages des tâches d'ingestion (table `runs`), que lit l'état des tâches
 * (`worker/status.ts`). Chaque étape d'un passage donne signe de vie (`alive_at`, `beat`) ; sans
 * signe de vie depuis 5 min (`aliveSince`), il ne tourne plus (son Workflow arrêté), même si rien
 * n'a pu noter sa fin.
 */

import { env } from 'cloudflare:workers'
import { aliveSince, type IngestJob } from '@/config/jobs'
import { HOUR, MINUTE } from '@/lib/time'

/**
 * Les tâches qui lisent les pages de Pokécardex : une seule à la fois. Son rythme (une page toutes
 * les 3 s, `pokecardex.ts`) n'est tenu que dans un Workflow : deux à la fois le doubleraient.
 */
const POKECARDEX_PAGES: IngestJob[] = ['catalog', 'history']

/** Les tâches qu'un passage de `job` ne doit pas croiser : elle-même, et celles de ses pages. */
const exclusive = (job: IngestJob) => (POKECARDEX_PAGES.includes(job) ? POKECARDEX_PAGES : [job])

/**
 * Commence un passage de `job` : son id, ou `null` si la tâche tourne déjà, ou une tâche qui lit
 * les mêmes pages (un passage ouvert, en vie). Un passage de `job` ouvert sans signe de vie est noté
 * interrompu, terminé à son dernier signe de vie. D'un seul tenant (`batch`) : deux passages lancés
 * ensemble ne commencent pas tous deux.
 */
export async function startRun(job: IngestJob) {
  const now = Date.now()
  const at = new Date(now).toISOString()
  const [, started] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE runs SET finished_at = alive_at, ok = 0, message = 'interrompue'
       WHERE job = ? AND finished_at IS NULL AND alive_at < ?`,
    ).bind(job, aliveSince(now)),
    env.DB.prepare(
      `INSERT INTO runs (job, started_at, alive_at) SELECT ?1, ?2, ?2
       WHERE NOT EXISTS (SELECT 1 FROM runs WHERE job IN (SELECT value FROM json_each(?3))
                         AND finished_at IS NULL AND alive_at >= ?4)
       RETURNING id`,
    ).bind(job, at, JSON.stringify(exclusive(job)), aliveSince(now)),
  ])
  return (started!.results[0] as { id: number } | undefined)?.id ?? null
}

/** Note la fin d'un passage : réussi (`null`), ou la cause de son échec. */
export async function finishRun(id: number, message: string | null) {
  await env.DB.prepare('UPDATE runs SET finished_at = ?, ok = ?, message = ? WHERE id = ?')
    .bind(new Date().toISOString(), message === null ? 1 : 0, message, id)
    .run()
}

/**
 * Le signe de vie d'un passage, au début de chacune de ses étapes, puis chaque minute des plus
 * longues (`Alive`, `workflow.ts`).
 */
export async function beat(id: number) {
  await env.DB.prepare('UPDATE runs SET alive_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), id)
    .run()
}

/**
 * La marge du Cron : il passe chaque heure, et un passage commence un peu après le Cron qui l'a
 * lancé (le Workflow créé, sa première étape). Sans elle, une tâche de 6 h commencée à 6 h 00 min
 * 03 s ne serait pas due au Cron de midi, quelques secondes trop tôt, mais à celui de 13 h : 7 h au
 * lieu de 6.
 */
const CRON_MARGIN = 10 * MINUTE

/**
 * La tâche à rythme `job` est-elle à relancer (testé) : jamais passée ; réussie, son intervalle
 * (`every`) écoulé depuis le début du passage (sa durée n'y change rien) ; en échec, depuis sa fin
 * (un essai coupé à 30 min ne la fait pas repartir aussitôt), le délai : 10 min, puis 20, 40…
 * jusqu'à 6 h (une panne qui dure ne fait pas solliciter la source à chaque fois). Chacun moins la
 * marge du Cron (`CRON_MARGIN`) : au Cron d'après l'intervalle, pas à celui d'une heure plus tard.
 * Le Cron passant chaque heure, les délais réels : 6 h après une réussite ; après 1 à 3 échecs
 * d'affilée, le Cron suivant ; après 4, 2 h ; après 5, 3 h ; ensuite 6 h.
 */
export async function isDue(job: IngestJob, every: number) {
  const { results } = await env.DB.prepare(
    `SELECT ok, started_at AS startedAt, finished_at AS finishedAt FROM runs
     WHERE job = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 10`,
  )
    .bind(job)
    .all<{ ok: number; startedAt: string; finishedAt: string }>()
  const [last] = results
  if (!last) return true
  // Les échecs d'affilée : les passages avant la dernière réussite.
  const lastSuccess = results.findIndex((run) => run.ok === 1)
  const streak = lastSuccess < 0 ? results.length : lastSuccess
  const wait = streak ? Math.min(10 * MINUTE * 2 ** (streak - 1), 6 * HOUR) : every
  const since = streak ? last.finishedAt : last.startedAt
  return Date.now() - Date.parse(since) >= wait - CRON_MARGIN
}
