/**
 * Les passages des tâches (`worker/ingest/runs.ts`) : une tâche qui tourne déjà (un passage ouvert
 * qui donne signe de vie) n'est pas lancée une seconde fois, ni `catalog` pendant `history` (elles
 * lisent les mêmes pages : deux à la fois doubleraient le rythme convenu avec la source) ; un
 * passage arrêté net (sans signe de vie depuis 5 min : son Workflow arrêté) ne bloque plus sa
 * tâche, et il est noté interrompu. Sinon, après un arrêt brutal, plus rien ne relancerait
 * l'historique des prix. Et quand le Cron relance une tâche à rythme (`isDue`) : à son intervalle
 * (depuis le début du passage, moins la marge du Cron : au Cron 6 h plus tard, pas 7 h), plus
 * tôt après un échec, de plus en plus tard s'ils se suivent ; il ne lance que `species` et
 * `prices`, jamais `catalog`, `images` ni `history` (à la demande seulement).
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
    const orphan = await openRun('history', 6 * MINUTE)
    const id = await startRun('history')
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
    const running = await openRun('history', 2 * MINUTE)
    expect(await startRun('history')).toBeNull()
    expect((await run(running)).finished_at).toBeNull()
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM runs').first()).toEqual({
      count: 1,
    })
  })

  test('le passage en vie d’une autre tâche ne bloque pas celle-ci', async () => {
    const prices = await openRun('prices', MINUTE)
    expect(await startRun('history')).not.toBeNull()
    expect((await run(prices)).finished_at).toBeNull()
  })

  test('catalog et history lisent les mêmes pages : l’une en vie bloque l’autre, pas un passage arrêté net', async () => {
    const catalog = await openRun('catalog', MINUTE)
    expect(await startRun('history')).toBeNull()
    expect((await run(catalog)).finished_at).toBeNull()
    await clear()
    await openRun('history', MINUTE)
    expect(await startRun('catalog')).toBeNull()
    // Sans signe de vie depuis plus de 5 min : il ne bloque plus l'autre.
    await clear()
    const orphan = await openRun('history', 6 * MINUTE)
    expect(await startRun('catalog')).not.toBeNull()
    expect((await run(orphan)).finished_at).toBeNull()
    expect(await startRun('images')).not.toBeNull()
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

  test('seulement les tâches à rythme qui sont dues : species puis prices, jamais les autres', async () => {
    // Un vrai Workflow lirait les sources : seule sa création est notée.
    const create = vi
      .spyOn(env.INGEST, 'create')
      .mockResolvedValue({ id: 'essai' } as WorkflowInstance)
    try {
      // Aucun passage : toutes seraient dues, si elles avaient un rythme.
      await worker.scheduled(createScheduledController(), env)
      expect(create.mock.calls).toEqual([
        [{ params: { jobs: ['species'] } }],
        [{ params: { jobs: ['prices'] } }],
      ])
      // Réussies à l'instant : rien à lancer.
      create.mockClear()
      await finished('species', [1, 0])
      await finished('prices', [1, 0])
      await worker.scheduled(createScheduledController(), env)
      expect(create).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
    }
  })
})
