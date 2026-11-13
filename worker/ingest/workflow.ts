/**
 * Les tâches d'ingestion, dans un Workflow (`ingest`, `Ingest`) : il passe celles qu'on lui donne
 * (`jobs`), l'une après l'autre ; une en échec n'empêche pas les suivantes. Le Cron lance celles à
 * rythme (`prices`, `catalog`, `species`) quand elles sont dues (`index.ts`) ; `bun run ingest`
 * lance une tâche tout de suite, et `sprites`, à la demande. Chaque tâche avance par étapes
 * (`Step`) : le Workflow garde le résultat de chacune, et une étape en échec (une panne) est
 * reprise seule, sans refaire les précédentes. Chaque passage est noté (`runs.ts`, lu par
 * `/v1/status`), avec la cause d'un échec (`message`, aussi au journal) et un signe de vie au
 * début de chaque étape, puis chaque minute d'une étape longue (`Alive`) ; une tâche déjà en cours
 * n'est pas lancée une seconde fois.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { INGEST_JOBS, type IngestJob } from '@/config/jobs'
import { MINUTE } from '@/lib/time'
import { reasonOf, taskJournal } from '../journal'
import { catalog } from './catalog'
import { prices } from './prices'
import { beat, finishRun, startRun } from './runs'
import { species } from './species'
import { sprites } from './sprites'

export interface IngestParams {
  jobs: IngestJob[]
}

/**
 * Le signe de vie d'une étape longue, que la tâche redonne en route (`catalog` à chaque page de
 * cartes et à chaque réponse, `prices` après ses lectures et à chaque paquet) : noté au plus une
 * fois par minute, l'étape en donnant déjà un en commençant. Sans signe de vie depuis 5 min, le
 * passage est tenu pour arrêté (`runs.ts`).
 */
export type Alive = () => Promise<void>

/**
 * Une étape d'une tâche : son nom (unique dans le passage) et ce qu'elle fait (`alive` : son signe
 * de vie, que les étapes courtes ignorent) ; son résultat, gardé par le Workflow, est rendu tel
 * quel si le passage reprend. Le journal s'écrit donc dans les étapes : une ligne écrite hors
 * d'elles serait réécrite à chaque reprise.
 */
export type Step = <T extends Rpc.Serializable<T>>(
  name: string,
  run: (alive: Alive) => Promise<T>,
) => Promise<T>

/**
 * Une étape réessaie une panne (la base, R2) deux fois, une puis deux minutes plus tard ; au-delà,
 * la tâche échoue. Chaque essai a 30 min (10 sans `timeout` : la plus longue étape, le relevé des
 * prix, pourrait les dépasser, et un essai tenu pour échoué peut écrire encore pendant le
 * suivant) ; au-delà, il compte comme une panne. Les images en erreur ne lèvent rien : leur étape
 * les compte.
 */
const RETRIES = {
  retries: { limit: 2, delay: '1 minute', backoff: 'exponential' },
  timeout: '30 minutes',
} as const

export class Ingest extends WorkflowEntrypoint<Cloudflare.Env, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const { jobs } = event.payload
    for (const [index, job] of jobs.entries()) {
      const prefix = `${index + 1}. ${job}`
      // Le journal dans les étapes, comme dans les tâches (`Step`).
      const id = await step.do(`${prefix} : début`, async () => {
        const id = await startRun(job)
        if (id === null) taskJournal('warn', 'Tâche déjà en cours', { tâche: job })
        return id
      })
      if (id === null) continue
      // Chaque étape donne signe de vie au passage (`beat`) en commençant, puis quand la tâche le
      // redit (`Alive`), une minute au moins après le précédent.
      const jobStep: Step = (name, run) =>
        step.do(`${prefix} : ${name}`, RETRIES, async () => {
          await beat(id)
          let last = Date.now()
          return run(async () => {
            if (Date.now() - last < MINUTE) return
            last = Date.now()
            await beat(id)
          })
        })
      try {
        if (job === 'catalog') await catalog(jobStep)
        else if (job === 'sprites') await sprites(jobStep)
        else if (job === 'species') await species(jobStep)
        else await jobStep('guide des prix', prices)
        await step.do(`${prefix} : fin`, async () => {
          await finishRun(id, null)
          taskJournal('ok', INGEST_JOBS[job].label)
        })
      } catch (error) {
        const reason = reasonOf(error)
        await step.do(`${prefix} : échec`, async () => {
          await finishRun(id, reason)
          taskJournal('error', `${INGEST_JOBS[job].label} en échec`, { raison: reason })
        })
      }
    }
  }
}
