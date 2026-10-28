/**
 * Le Worker des données. Deux entrées, la même API (`app.ts`) :
 * - par défaut, l'entrée d'Internet (`https://api.pokecodex.fr`, pour les autres clients que le
 *   site : un script, une autre app) : les limites par adresse (`limits.ts`), puis le token
 *   (`auth.ts`) ;
 * - `SiteEntrypoint`, celle du site : sa liaison de service (`services` de son `wrangler.jsonc`),
 *   que rien d'autre ne peut joindre ; ni token ni limite.
 * Et les tâches d'ingestion (`ingest/`) : le Workflow `Ingest`, que le Cron (`scheduled`, chaque
 * heure) lance pour chaque tâche à rythme qui est due (`isDue`).
 */

import { WorkerEntrypoint } from 'cloudflare:workers'
import { INGEST_JOB_NAMES, INGEST_JOBS } from '@/config/jobs'
import { app } from './app'
import { guard } from './auth'
import { isDue } from './ingest/runs'
import { limited } from './limits'

export { Ingest } from './ingest/workflow'

export default {
  async fetch(request) {
    return (await limited(request)) ?? (await guard(request)) ?? app.fetch(request)
  },
  async scheduled(_controller, env) {
    for (const job of INGEST_JOB_NAMES) {
      const { every } = INGEST_JOBS[job]
      if (every !== null && (await isDue(job, every))) {
        await env.INGEST.create({ params: { jobs: [job] } })
      }
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>

export class SiteEntrypoint extends WorkerEntrypoint<Cloudflare.Env> {
  fetch(request: Request) {
    return app.fetch(request)
  }
}
