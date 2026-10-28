/**
 * `bun run ingest <tâche>` : lance un passage des tâches d'ingestion (le Workflow `ingest`,
 * `worker/ingest/workflow.ts`) dans le Worker que sert `bun run dev`.
 *
 *   bun run ingest <tâche>   species, catalog, images, prices, history
 *   bun run ingest cards     les nouvelles cartes : catalogue, puis leurs images et leur historique
 *   bun run ingest setup     l'initialisation complète : espèces, catalogue, prix, images, historique
 *   … --refresh              catalog : relit toutes les séries, même celles lues récemment
 *   … --remote               dans le Worker en ligne, plutôt que celui de `bun run dev`
 *
 * Le passage se suit dans le terminal de `bun run dev` (le journal) et sur la page Données du site.
 * Le catalogue avant les prix dans `setup` : le prix d'une carte d'une série récente est sa
 * tendance (d'après le catalogue) ; lu sans lui, il serait faux, et le resterait dans l'historique.
 */

import { INGEST_JOB_NAMES, type IngestJob } from '../src/config/jobs'

const SEQUENCES: Record<string, IngestJob[]> = {
  cards: ['catalog', 'images', 'history'],
  setup: ['species', 'catalog', 'prices', 'images', 'history'],
}

const [name = '', ...flags] = process.argv.slice(2)
const jobs =
  SEQUENCES[name] ?? (INGEST_JOB_NAMES.includes(name as IngestJob) ? [name as IngestJob] : null)
if (!jobs) {
  console.error(`Tâches : ${INGEST_JOB_NAMES.join(', ')} ; cards ; setup (--refresh, --remote)`)
  process.exit(1)
}
const params = JSON.stringify({ jobs, refresh: flags.includes('--refresh') })
const target = flags.includes('--remote') ? [] : ['--local']
const { exitCode } = Bun.spawnSync(
  ['bunx', 'wrangler', 'workflows', 'trigger', 'ingest', params, ...target],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exit(exitCode)
