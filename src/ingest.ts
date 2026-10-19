/**
 * Les tâches d'ingestion : chacune lit une ou plusieurs sources et écrit dans `data.db`.
 *
 *   bun src/ingest.ts <tâche>     une tâche, tout de suite (`bun run ingest prices`)
 *   bun src/ingest.ts cards       les nouvelles cartes : catalogue, puis leurs images et leur
 *                                 historique (les trois tâches à la demande, l'une après l'autre)
 *   bun src/ingest.ts --loop      service `ingest` : chaque tâche à rythme, à son rythme
 *
 * En boucle, au démarrage : les réponses calculées de l'API (`snapshots`) sont refaites (leur
 * forme a pu changer avec le code déployé) : le catalogue d'après ses tables, les espèces en
 * repassant leur tâche (elle relit le cache disque de PokéAPI, sans requête s'il a moins d'un
 * mois). Puis une tâche repart quand sa dernière réussite a plus que son intervalle
 * (`INGEST_JOBS`) ; après un échec (source indisponible…), 10 min plus tard, puis 20, 40… jusqu'à
 * 6 h : une panne qui dure ne fait pas solliciter la source toutes les 10 min. Les tâches à la
 * demande (`catalog`, `images`, `history`) n'y passent jamais. Chaque passage est noté dans `runs`
 * (lu par `/v1/status`) ; arrêté (Ctrl+C, `docker compose stop`), il est noté interrompu.
 */

import type { Database } from 'bun:sqlite'
import { INGEST_JOB_NAMES, INGEST_JOBS, type IngestJob } from '@/config/jobs'
import { DAY, HOUR } from '@/lib/time'
import { openData } from './db'
import { backups } from './jobs/backups'
import { catalog, saveCatalog } from './jobs/catalog'
import { history } from './jobs/history'
import { images } from './jobs/images'
import { prices } from './jobs/prices'
import { species } from './jobs/species'

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

/** Celles de la boucle, chacune à son rythme. */
const SCHEDULED = INGEST_JOB_NAMES.filter((name) => INGEST_JOBS[name].every !== null)

/** Le passage en cours dans ce processus : noté interrompu si on l'arrête. */
let current: number | null = null

async function runJob(db: Database, name: IngestJob) {
  // Déjà en cours dans un autre processus (une tâche lancée deux fois) : deux à la fois
  // doubleraient le rythme des requêtes. Au-delà de 2 jours (l'historique en prend un la première
  // fois), un reste d'arrêt brutal.
  const running = db
    .query('SELECT 1 FROM runs WHERE job = ? AND finished_at IS NULL AND started_at > ?')
    .get(name, new Date(Date.now() - 2 * DAY).toISOString())
  if (running) {
    console.warn(`Tâche ${name} déjà en cours dans un autre processus : rien de lancé.`)
    return false
  }
  const { id } = db
    .query('INSERT INTO runs (job, started_at) VALUES (?, ?) RETURNING id')
    .get(name, new Date().toISOString()) as { id: number }
  current = id
  try {
    await RUNS[name](db)
    finish(db, id, true, null)
    return true
  } catch (error) {
    console.error(`Tâche ${name} en échec :`, error)
    finish(db, id, false, error instanceof Error ? error.message : String(error))
    return false
  } finally {
    current = null
  }
}

function finish(db: Database, id: number, ok: boolean, message: string | null) {
  db.query('UPDATE runs SET finished_at = ?, ok = ?, message = ? WHERE id = ?').run(
    new Date().toISOString(),
    ok ? 1 : 0,
    message,
    id,
  )
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
  const wait = streak ? Math.min(600_000 * 2 ** (streak - 1), 6 * HOUR) : every
  return Date.now() - Date.parse(last.finished_at) >= wait
}

const db = openData()
const [arg] = process.argv.slice(2)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (current !== null) finish(db, current, false, 'interrompue')
    process.exit(130)
  })
}

if (arg === '--loop') {
  // Un passage arrêté net (machine redémarrée) reste « en cours » : il ne l'est plus. Seulement
  // ceux de la boucle : une tâche à la demande tourne peut-être dans un autre conteneur.
  db.query(
    `UPDATE runs SET finished_at = ?, ok = 0, message = 'interrompue'
     WHERE finished_at IS NULL AND job IN (SELECT value FROM json_each(?))`,
  ).run(new Date().toISOString(), JSON.stringify(SCHEDULED))
  saveCatalog(db)
  // Les espèces sont enregistrées telles que les lit le code : repassées avec le code déployé.
  await runJob(db, 'species')
  for (;;) {
    for (const name of SCHEDULED) {
      if (isDue(db, name, INGEST_JOBS[name].every!)) await runJob(db, name)
    }
    await Bun.sleep(60_000)
  }
} else if (arg === 'cards') {
  // Toutes les trois, même après un échec (quelques pages ou images en erreur) : chacune fait ce
  // qu'elle peut de ce qui est là.
  let ok = true
  for (const name of CARDS) ok = (await runJob(db, name)) && ok
  if (!ok) process.exit(1)
} else if (INGEST_JOB_NAMES.includes(arg as IngestJob)) {
  if (!(await runJob(db, arg as IngestJob))) process.exit(1)
} else {
  console.error(`Tâches : ${INGEST_JOB_NAMES.join(', ')} ; cards ; ou --loop`)
  process.exit(1)
}
