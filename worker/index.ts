/**
 * Le Worker des données. Deux entrées, la même API (`app.ts`) :
 * - par défaut, l'entrée d'Internet (`https://api.pokecodex.fr`, pour les autres clients que le
 *   site : un script, une autre app) : en https (http : 301 vers https, ou 403 pour une requête
 *   qui porte un token ; pas sur le poste du développeur), lecture seule (tout autre verbe : 405),
 *   la limite par réseau (`limits.ts`), le token (`auth.ts`), puis les limites des routes
 *   coûteuses par client ; ses en-têtes, ceux d'une API (`API_HEADERS`) ;
 * - `SiteEntrypoint`, celle du site : sa liaison de service (`services` de son `wrangler.jsonc`),
 *   que rien d'autre ne peut joindre ; ni token ni limite.
 * Et les tâches d'ingestion (`ingest/`) : le Workflow `Ingest`, que le Cron (`scheduled`, chaque
 * heure) lance avec les tâches dues (`isDue`, ou une sortie absente de R2 : `missingOutputs`).
 */

import { WorkerEntrypoint } from 'cloudflare:workers'
import { INGEST_JOB_NAMES, INGEST_JOBS, type IngestJob } from '@/config/jobs'
import { app } from './app'
import { guard, sentInClear } from './auth'
import { isDue, missingOutputs } from './ingest/runs'
import { limited, limitedHeavy } from './limits'

export { Ingest } from './ingest/workflow'

/**
 * Les en-têtes de chaque réponse de l'entrée d'Internet : en https seulement pendant un an (le
 * même engagement que le site, sous-domaines compris), pas de type deviné, aucune adresse d'origine
 * transmise, rien à afficher dans une page ni dans le cadre d'un autre site, rien à indexer.
 */
const API_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Robots-Tag': 'noindex, nofollow',
}

/**
 * Le poste du développeur, en http : `bun run dev` (son adresse locale, pas celle de `routes` :
 * `--infer-origin-from-routes=false`) et les tests.
 */
const LOCAL = /^(localhost|127\.0\.0\.1)$/

async function internet(request: Request) {
  const url = new URL(request.url)
  if (url.protocol === 'http:' && !LOCAL.test(url.hostname)) {
    if (request.headers.has('authorization')) return sentInClear(request)
    url.protocol = 'https:'
    return Response.redirect(url.href, 301)
  }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const refused = await limited(request)
  if (refused) return refused
  const client = await guard(request)
  if (client instanceof Response) return client
  return (await limitedHeavy(request, client)) ?? app.fetch(request)
}

export default {
  async fetch(request) {
    const answer = await internet(request)
    // Une copie : une réponse faite d'un objet de R2 (une image) ne se modifie pas.
    const response = new Response(answer.body, answer)
    for (const [name, value] of Object.entries(API_HEADERS)) response.headers.set(name, value)
    return response
  },
  // Les tâches dues, dans un seul passage, dans l'ordre d'`INGEST_JOBS` : le catalogue avant les
  // prix, qui en lisent le miroir (la sortie de chaque série : la tendance pour une série récente) ;
  // deux passages séparés pourraient finir dans l'autre ordre, et un prix faux resterait dans
  // l'historique. Une tâche dont une sortie manque dans R2 est due aussi, sans rythme (`sprites`)
  // ou avant son intervalle, au rythme des nouvelles tentatives après un échec (`isDue(job, 0)`).
  async scheduled(_controller, env) {
    const missing = await missingOutputs()
    const due: IngestJob[] = []
    for (const job of INGEST_JOB_NAMES) {
      const { every } = INGEST_JOBS[job]
      if (missing.has(job) ? await isDue(job, 0) : every !== null && (await isDue(job, every))) {
        due.push(job)
      }
    }
    if (due.length) await env.INGEST.create({ params: { jobs: due } })
  },
} satisfies ExportedHandler<Cloudflare.Env>

export class SiteEntrypoint extends WorkerEntrypoint<Cloudflare.Env> {
  fetch(request: Request) {
    return app.fetch(request)
  }
}
