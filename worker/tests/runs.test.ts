/**
 * Les passages des tâches (`worker/ingest/runs.ts`) : une tâche qui tourne déjà (un passage ouvert
 * qui donne signe de vie) n'est pas lancée une seconde fois ; un passage arrêté net (sans signe de
 * vie depuis 5 min : son Workflow arrêté) ne bloque plus sa tâche, et il est noté interrompu.
 * Sinon, après un arrêt brutal, plus rien ne relancerait les prix. Et quand le Cron relance une
 * tâche à rythme (`isDue`) : à son intervalle (depuis le début du passage, moins la marge du
 * Cron : au Cron 6 h plus tard, pas 7 h), plus tôt après un échec, de plus en plus tard s'ils se
 * suivent. Le Cron lance les tâches dues dans un seul passage, dans l'ordre (le catalogue avant
 * les prix, qui lisent son miroir : un prix faux resterait dans l'historique) ; `sprites`, à la
 * demande, seulement si une de ses sorties manque, comme toute tâche dont une sortie a été effacée
 * de R2 (avant son rythme).
 */

import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DAY, HOUR, MINUTE } from '@/lib/time'
import worker from '../index'
import { isDue, startRun } from '../ingest/runs'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** Un passage ouvert de `job`, commencé il y a un jour, son dernier signe de vie il y a `alive`. */
const openRun = async (job: string, alive: number) =>
  (await env.DB.prepare(
    'INSERT INTO runs (job, started_at, alive_at) VALUES (?, ?, ?) RETURNING id',
  )
    .bind(job, ago(DAY), ago(alive))
    .first<{ id: number }>())!.id

const run = async (id: number) =>
  (await env.DB.prepare('SELECT finished_at, ok, message, alive_at FROM runs WHERE id = ?')
    .bind(id)
    .first<{
      finished_at: string | null
      ok: number | null
      message: string | null
      alive_at: string
    }>())!

const clear = () => env.DB.prepare('DELETE FROM runs').run()

describe('startRun', () => {
  beforeEach(clear)

  test('un passage ouvert sans signe de vie depuis plus de 5 min : la tâche démarre, lui est noté interrompu', async () => {
    const orphan = await openRun('catalog', 6 * MINUTE)
    const id = await startRun('catalog')
    expect(id).not.toBeNull()
    const closed = await run(orphan)
    expect(closed).toEqual({
      finished_at: closed.alive_at,
      ok: 0,
      message: 'interrompue',
      alive_at: closed.alive_at,
    })
    expect(await run(id!)).toMatchObject({ finished_at: null, ok: null, message: null })
  })

  test('un passage qui donne signe de vie, même commencé il y a longtemps : la tâche ne démarre pas', async () => {
    const running = await openRun('catalog', 2 * MINUTE)
    expect(await startRun('catalog')).toBeNull()
    expect((await run(running)).finished_at).toBeNull()
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM runs').first()).toEqual({
      count: 1,
    })
  })

  test('le passage en vie d’une autre tâche ne bloque pas celle-ci', async () => {
    const prices = await openRun('prices', MINUTE)
    expect(await startRun('catalog')).not.toBeNull()
    expect(await startRun('sprites')).not.toBeNull()
    expect((await run(prices)).finished_at).toBeNull()
  })
})

/** Des passages terminés de `job`, du plus ancien au plus récent. */
const finished = async (job: string, ...rows: [ok: 0 | 1, ago: number][]) => {
  const write = env.DB.prepare(
    'INSERT INTO runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, ?)',
  )
  await env.DB.batch(rows.map(([ok, ms]) => write.bind(job, ago(ms), ago(ms), ok)))
}

describe('isDue : quand le Cron relance une tâche à rythme', () => {
  beforeEach(clear)

  test('jamais passée : tout de suite ; réussie : à son intervalle', async () => {
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
    await finished('prices', [1, DAY], [0, 6 * HOUR], [1, 5 * HOUR])
    expect(await isDue('prices', 6 * HOUR)).toBe(false)
    await clear()
    await finished('prices', [1, 7 * HOUR])
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
  })

  test('la marge du Cron : réussie, commencée il y a 5 h 51 (après le Cron d’il y a 6 h), due ; il y a 5 h 49, pas encore', async () => {
    await finished('prices', [1, 6 * HOUR - 9 * MINUTE])
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
    await clear()
    await finished('prices', [1, 6 * HOUR - 11 * MINUTE])
    expect(await isDue('prices', 6 * HOUR)).toBe(false)
    // Depuis son début : un long passage, commencé il y a 5 h 59 et fini il y a 5 h, est dû.
    await clear()
    await env.DB.prepare('INSERT INTO runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, 1)')
      .bind('prices', ago(6 * HOUR - MINUTE), ago(5 * HOUR))
      .run()
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
  })

  test('après un échec, au Cron suivant ; après plusieurs, de plus en plus tard, 6 h au plus', async () => {
    await finished('prices', [1, DAY], [0, 1 * MINUTE])
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
    await clear()
    // Trois échecs d'affilée : 40 min d'attente, moins la marge du Cron.
    await finished('prices', [1, DAY], [0, 3 * HOUR], [0, 2 * HOUR], [0, 29 * MINUTE])
    expect(await isDue('prices', 6 * HOUR)).toBe(false)
    await clear()
    await finished('prices', [1, DAY], [0, 3 * HOUR], [0, 2 * HOUR], [0, 31 * MINUTE])
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
    await clear()
    // Dix échecs : 6 h, pas 85.
    const failures = Array.from({ length: 10 }, (_, index): [0, number] => [
      0,
      6 * HOUR + (10 - index) * MINUTE,
    ])
    await finished('prices', ...failures)
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
    // Un échec se mesure depuis sa fin : quatre échecs (70 min), le dernier commencé il y a 95 min
    // (des essais coupés à 30 min) et fini il y a 5 min, pas encore dû.
    await clear()
    await finished('prices', [1, DAY], [0, 5 * HOUR], [0, 4 * HOUR], [0, 3 * HOUR])
    await env.DB.prepare('INSERT INTO runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, 0)')
      .bind('prices', ago(95 * MINUTE), ago(5 * MINUTE))
      .run()
    expect(await isDue('prices', 6 * HOUR)).toBe(false)
  })
})

describe('le Cron', () => {
  beforeEach(clear)

  /** Ce que les tâches écrivent dans R2 (`missingOutputs`) : présent, sauf `except`. */
  const outputs = async (...except: string[]) => {
    const keys = [
      'snapshots/species.json',
      'snapshots/species-details.json',
      'snapshots/catalog/sets.json',
      'snapshots/catalog/fr/sets.json',
      'images/species/1025.png',
      'images/species/artwork/1025.png',
    ]
    await Promise.all(keys.map((key) => env.FILES.put(key, '{}')))
    if (except.length) await env.FILES.delete(except)
  }

  /** Les passages créés par un Cron : un vrai Workflow lirait les sources, seule sa création compte. */
  async function cron() {
    const create = vi
      .spyOn(env.INGEST, 'create')
      .mockResolvedValue({ id: 'essai' } as WorkflowInstance)
    try {
      await worker.scheduled(createScheduledController(), env)
      return create.mock.calls.map(([options]) => options)
    } finally {
      create.mockRestore()
    }
  }

  test('les tâches dues dans un seul passage, dans l’ordre : le catalogue avant les prix', async () => {
    await outputs()
    // Aucun passage : toutes celles à rythme sont dues ; jamais `sprites`, ses sorties présentes.
    expect(await cron()).toEqual([{ params: { jobs: ['species', 'catalog', 'prices'] } }])
    // Réussies à l'instant : rien à lancer.
    await finished('species', [1, 0])
    await finished('catalog', [1, 0])
    await finished('prices', [1, 0])
    expect(await cron()).toEqual([])
  })

  test('une sortie effacée de R2 : sa tâche relancée avant son rythme, à la demande comprise ; après un échec, au rythme des nouvelles tentatives', async () => {
    await finished('species', [1, 0])
    await finished('catalog', [1, 0])
    await finished('prices', [1, 0])
    await outputs('snapshots/species.json', 'images/species/artwork/1025.png')
    expect(await cron()).toEqual([{ params: { jobs: ['species', 'sprites'] } }])
    // `sprites` vient d'échouer trois fois : pas avant 40 min (moins la marge du Cron).
    await finished('sprites', [0, 3 * MINUTE], [0, 2 * MINUTE], [0, MINUTE])
    expect(await cron()).toEqual([{ params: { jobs: ['species'] } }])
  })
})
