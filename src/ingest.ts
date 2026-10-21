/**
 * Les tâches d'ingestion : chacune lit une ou plusieurs sources et écrit dans `data.db`.
 *
 *   bun src/ingest.ts <tâche>     une tâche, tout de suite (`bun run ingest prices`)
 *   bun src/ingest.ts cards       les nouvelles cartes : catalogue, puis leurs images et leur
 *                                 historique (les trois tâches à la demande, l'une après l'autre)
 *   bun src/ingest.ts setup       l'initialisation complète : espèces, prix, puis `cards`
 *   bun src/ingest.ts --loop      service `ingest` : chaque tâche à rythme, à son rythme
 *
 * En boucle, au démarrage : les réponses calculées de l'API (`snapshots`) sont refaites (leur
 * forme a pu changer avec le code déployé) : le catalogue d'après ses tables, les espèces en
 * repassant leur tâche (elle relit le cache disque de PokéAPI, sans requête s'il a moins d'un
 * mois). Puis une tâche repart quand sa dernière réussite a plus que son intervalle
 * (`INGEST_JOBS`) ; après un échec (source indisponible…), 10 min plus tard, puis 20, 40… jusqu'à
 * 6 h : une panne qui dure ne fait pas solliciter la source toutes les 10 min. Les tâches à la
 * demande (`catalog`, `images`, `history`) n'y passent jamais. Chaque passage est noté dans `runs`
 * (`runs.ts`, lu par `/v1/status`), avec la cause d'un échec (`message`, aussi dans la sortie) ;
 * arrêté (Ctrl+C, `docker compose stop`), il est noté interrompu. Il donne signe de vie chaque
 * minute : arrêté net (conteneur tué, machine redémarrée), il est noté interrompu au passage
 * suivant de sa tâche, qui n'attend que 5 min.
 */

import type { Database } from 'bun:sqlite'
import { INGEST_JOB_NAMES, INGEST_JOBS, type IngestJob } from '@/config/jobs'
import { HOUR, MINUTE } from '@/lib/time'
import { openData } from './db'
import { backups } from './jobs/backups'
import { catalog, saveCatalog } from './jobs/catalog'
import { history } from './jobs/history'
import { images } from './jobs/images'
import { prices } from './jobs/prices'
import { species } from './jobs/species'
import { finishRun, keepAlive, startRun } from './runs'
import { duration, failure, muted, strong, success } from './terminal-progress'

const RUNS: Record<IngestJob, (db: Database) => Promise<void>> = {
  species,
  catalog,
  images,
  prices,
  history,
  backups,
}

/** Les tâches de `cards`, dans l'ordre : les images et l'historique suivent le catalogue. */
const CARDS: IngestJob[] = ['catalog', 'images', 'history']

/** Toutes les données nécessaires à une première installation. */
const SETUP: IngestJob[] = ['species', 'prices', ...CARDS]

/** Celles de la boucle, chacune à son rythme. */
const SCHEDULED = INGEST_JOB_NAMES.filter((name) => INGEST_JOBS[name].every !== null)

/** Le passage en cours dans ce processus : noté interrompu si on l'arrête. */
let current: number | null = null

async function runJob(db: Database, name: IngestJob, step?: { current: number; total: number }) {
  const started = Date.now()
  if (step) {
    console.log(`\n${muted(`[${step.current}/${step.total}]`)} ${strong(INGEST_JOBS[name].label)}`)
  }
  // Déjà en cours dans un autre processus, en vie (une tâche lancée deux fois) : deux à la fois
  // doubleraient le rythme des requêtes. Un passage arrêté net ne compte plus (`startRun`).
  const id = startRun(db, name)
  if (id === null) {
    console.warn(`Tâche ${name} déjà en cours dans un autre processus : rien de lancé.`)
    if (step) console.log(`${failure('✗')} Étape ignorée`)
    return false
  }
  current = id
  const stopBeating = keepAlive(db, id)
  try {
    await RUNS[name](db)
    finishRun(db, id, true, null)
    if (step) console.log(`${success('✓')} Terminée en ${duration(Date.now() - started)}`)
    return true
  } catch (error) {
    console.error(`Tâche ${name} en échec :`, error)
    finishRun(db, id, false, error instanceof Error ? error.message : String(error))
    if (step) console.log(`${failure('✗')} Échec après ${duration(Date.now() - started)}`)
    return false
  } finally {
    stopBeating()
    current = null
  }
}

/** Plusieurs tâches, avec leur étape et un bilan. Les suivantes passent même si l'une échoue. */
async function runSequence(db: Database, title: string, jobs: IngestJob[]) {
  const started = Date.now()
  console.log(`\n${strong(title)}`)
  console.log(muted(`${jobs.length} étapes · Ctrl+C pour interrompre, la reprise est automatique`))
  let ok = true
  for (const [index, name] of jobs.entries()) {
    ok = (await runJob(db, name, { current: index + 1, total: jobs.length })) && ok
  }
  console.log(
    `\n${ok ? success('✓') : failure('✗')} ${title} ${ok ? 'terminée' : 'terminée avec des erreurs'} ` +
      muted(`en ${duration(Date.now() - started)}`),
  )
  return ok
}

/** La tâche est-elle à relancer : jamais passée, intervalle écoulé, ou délai après un échec. */
function isDue(db: Database, name: IngestJob, every: number) {
  const runs = db
    .query(
      'SELECT ok, finished_at FROM runs WHERE job = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 10',
    )
    .all(name) as { ok: number; finished_at: string }[]
  const last = runs[0]
  if (!last) return true
  // Les échecs d'affilée : les passages avant la dernière réussite.
  const lastSuccess = runs.findIndex((run) => run.ok === 1)
  const streak = lastSuccess < 0 ? runs.length : lastSuccess
  const wait = streak ? Math.min(10 * MINUTE * 2 ** (streak - 1), 6 * HOUR) : every
  return Date.now() - Date.parse(last.finished_at) >= wait
}

const db = openData()
const [arg] = process.argv.slice(2)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (current !== null) finishRun(db, current, false, 'interrompue')
    process.exit(130)
  })
}

if (arg === '--loop') {
  saveCatalog(db)
  // Les espèces sont enregistrées telles que les lit le code : repassées avec le code déployé.
  await runJob(db, 'species')
  for (;;) {
    for (const name of SCHEDULED) {
      if (isDue(db, name, INGEST_JOBS[name].every!)) await runJob(db, name)
    }
    await Bun.sleep(MINUTE)
  }
} else if (arg === 'cards') {
  if (!(await runSequence(db, 'Mise à jour des cartes', CARDS))) process.exit(1)
} else if (arg === 'setup') {
  if (!(await runSequence(db, 'Initialisation des données', SETUP))) process.exit(1)
} else if (INGEST_JOB_NAMES.includes(arg as IngestJob)) {
  if (!(await runSequence(db, INGEST_JOBS[arg as IngestJob].label, [arg as IngestJob])))
    process.exit(1)
} else {
  console.error(`Tâches : ${INGEST_JOB_NAMES.join(', ')} ; cards ; setup ; ou --loop`)
  process.exit(1)
}
