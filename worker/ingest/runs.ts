/**
 * Les passages des tâches d'ingestion (table `runs`), que lit l'état des tâches
 * (`worker/status.ts`). Chaque étape d'un passage donne signe de vie (`alive_at`, `beat`) ; sans
 * signe de vie depuis 5 min (`aliveSince`), il ne tourne plus (son Workflow arrêté), même si rien
 * n'a pu noter sa fin.
 */

import { env } from 'cloudflare:workers'
import { aliveSince, type IngestJob } from '@/config/jobs'

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
export async function startRun(job: IngestJob, now = Date.now()) {
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

/** Note la fin d'un passage : réussi, ou la cause de son échec. */
export async function finishRun(id: number, ok: boolean, message: string | null) {
  await env.DB.prepare('UPDATE runs SET finished_at = ?, ok = ?, message = ? WHERE id = ?')
    .bind(new Date().toISOString(), ok ? 1 : 0, message, id)
    .run()
}

/** Le signe de vie d'un passage, au début de chacune de ses étapes. */
export async function beat(id: number) {
  await env.DB.prepare('UPDATE runs SET alive_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), id)
    .run()
}

/**
 * La tâche à rythme `job` est-elle à relancer : jamais passée, son intervalle (`every`) écoulé, ou
 * le délai après un échec : 10 min, puis 20, 40… jusqu'à 6 h (une panne qui dure ne fait pas
 * solliciter la source à chaque fois).
 */
export async function isDue(job: IngestJob, every: number, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT ok, finished_at AS finishedAt FROM runs
     WHERE job = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 10`,
  )
    .bind(job)
    .all<{ ok: number; finishedAt: string }>()
  const [last] = results
  if (!last) return true
  // Les échecs d'affilée : les passages avant la dernière réussite.
  const lastSuccess = results.findIndex((run) => run.ok === 1)
  const streak = lastSuccess < 0 ? results.length : lastSuccess
  const wait = streak ? Math.min(10 * 60_000 * 2 ** (streak - 1), 6 * 3_600_000) : every
  return now - Date.parse(last.finishedAt) >= wait
}
