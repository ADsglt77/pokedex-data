/**
 * Les tâches d'ingestion, dans un Workflow (`ingest`, `Ingest`) : il passe celles qu'on lui donne
 * (`jobs`), l'une après l'autre ; une en échec n'empêche pas les suivantes. Le Cron lance celles à
 * rythme (`prices`, `species`) quand elles sont dues (`index.ts`) ; `bun run ingest` lance les
 * autres à la demande (`cards` : `catalog`, `images`, `history`). Chaque tâche avance par étapes
 * (`Step`) : le Workflow garde le résultat de chacune, et une étape en échec (une panne) est
 * reprise seule, sans refaire les précédentes. Chaque passage est noté (`runs.ts`, lu par
 * `/v1/status`), avec la cause d'un échec (`message`, aussi au journal) ; une tâche déjà en cours,
 * ou une tâche qui lit les mêmes pages de Pokécardex, n'est pas lancée une seconde fois.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { INGEST_JOBS, type IngestJob } from '@/config/jobs'
import { journal, reasonOf } from '../journal'
import { catalog } from './catalog'
import { history } from './history'
import { images } from './images'
import { prices } from './prices'
import { beat, finishRun, startRun } from './runs'
import { species } from './species'

export interface IngestParams {
  jobs: IngestJob[]
  /** `catalog` : relire toutes les séries, même celles lues récemment. */
  refresh?: boolean
}

/**
 * Une étape d'une tâche : son nom (unique dans le passage) et ce qu'elle fait ; son résultat,
 * gardé par le Workflow, est rendu tel quel si le passage reprend.
 */
export type Step = <T extends Rpc.Serializable<T>>(
  name: string,
  run: () => Promise<T>,
) => Promise<T>

/**
 * Une étape réessaie une panne (la base, R2) deux fois, une puis deux minutes plus tard ; au-delà,
 * la tâche échoue. Les pages et les images en erreur ne lèvent rien : leur étape les compte.
 */
const RETRIES = { retries: { limit: 2, delay: '1 minute', backoff: 'exponential' } } as const

export class Ingest extends WorkflowEntrypoint<Cloudflare.Env, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const { jobs, refresh = false } = event.payload
    for (const [index, job] of jobs.entries()) {
      const prefix = `${index + 1}. ${job}`
      const id = await step.do(`${prefix} : début`, () => startRun(job))
      if (id === null) {
        journal({
          topic: 'tâches',
          level: 'warn',
          message: 'Tâche déjà en cours',
          details: { tâche: job, raison: 'elle-même, ou une tâche qui lit les mêmes pages' },
        })
        continue
      }
      // Chaque étape donne signe de vie au passage (`beat`).
      const jobStep: Step = (name, run) =>
        step.do(`${prefix} : ${name}`, RETRIES, async () => {
          await beat(id)
          return run()
        })
      try {
        if (job === 'catalog') await catalog(jobStep, refresh)
        else if (job === 'images') await images(jobStep)
        else if (job === 'history') await history(jobStep)
        else if (job === 'species') await species(jobStep)
        else await jobStep('guide des prix', prices)
        await step.do(`${prefix} : fin`, () => finishRun(id, null))
        journal({ topic: 'tâches', level: 'ok', message: INGEST_JOBS[job].label })
      } catch (error) {
        const reason = reasonOf(error)
        await step.do(`${prefix} : échec`, () => finishRun(id, reason))
        journal({
          topic: 'tâches',
          level: 'error',
          message: `${INGEST_JOBS[job].label} en échec`,
          details: { raison: reason },
        })
      }
    }
  }
}
