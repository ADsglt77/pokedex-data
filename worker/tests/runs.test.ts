/**
 * Les passages des tâches (`worker/ingest/runs.ts`) : une tâche qui tourne déjà (un passage ouvert
 * qui donne signe de vie) n'est pas lancée une seconde fois, ni `catalog` pendant `history` (elles
 * lisent les mêmes pages : deux à la fois doubleraient le rythme convenu avec la source) ; un
 * passage arrêté net (sans signe de vie depuis 5 min : son Workflow arrêté) ne bloque plus sa
 * tâche, et il est noté interrompu. Sinon, après un arrêt brutal, plus rien ne relancerait
 * l'historique des prix. Et quand le Cron relance une tâche à rythme (`isDue`) : à son intervalle,
 * plus tôt après un échec, de plus en plus tard s'ils se suivent.
 */

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, test } from 'vitest'
import { DAY, HOUR, MINUTE } from '@/lib/time'
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

describe('isDue : quand le Cron relance une tâche à rythme', () => {
  beforeEach(clear)

  /** Des passages terminés de `prices`, du plus ancien au plus récent. */
  const finished = async (...rows: [ok: 0 | 1, ago: number][]) => {
    const write = env.DB.prepare(
      'INSERT INTO runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, ?)',
    )
    await env.DB.batch(rows.map(([ok, ms]) => write.bind('prices', ago(ms), ago(ms), ok)))
  }

  test('jamais passée : tout de suite ; réussie : à son intervalle', async () => {
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
    await finished([1, DAY], [0, 6 * HOUR], [1, 5 * HOUR])
    expect(await isDue('prices', 6 * HOUR)).toBe(false)
    await clear()
    await finished([1, 7 * HOUR])
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
  })

  test('après un échec, 10 min plus tard ; après plusieurs, de plus en plus tard, 6 h au plus', async () => {
    await finished([1, DAY], [0, 11 * MINUTE])
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
    await clear()
    // Trois échecs d'affilée : 40 min d'attente.
    await finished([1, DAY], [0, 3 * HOUR], [0, 2 * HOUR], [0, 30 * MINUTE])
    expect(await isDue('prices', 6 * HOUR)).toBe(false)
    await clear()
    await finished([1, DAY], [0, 3 * HOUR], [0, 2 * HOUR], [0, 41 * MINUTE])
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
    await clear()
    // Dix échecs : 6 h, pas 85.
    const failures = Array.from({ length: 10 }, (_, index): [0, number] => [
      0,
      6 * HOUR + (10 - index) * MINUTE,
    ])
    await finished(...failures)
    expect(await isDue('prices', 6 * HOUR)).toBe(true)
  })
})
