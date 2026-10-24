/**
 * Les passages des tâches (`src/runs.ts`) : une tâche qui tourne dans un autre processus (un passage
 * ouvert qui donne signe de vie) n'est pas lancée une seconde fois, ni `catalog` pendant `history`
 * (elles lisent les mêmes pages : deux à la fois doubleraient le rythme convenu avec la source) ;
 * un passage arrêté net (sans signe de vie depuis 5 min : conteneur tué, machine redémarrée) ne
 * bloque plus sa tâche, et il est noté interrompu. Sinon, après un arrêt brutal, plus rien ne
 * relancerait l'historique des prix.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { DAY, MINUTE } from '../src/lib/time'
import { startRun } from '../src/runs'
import { testData } from './server'

const data = testData()

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** Un passage ouvert de `job`, commencé il y a un jour, son dernier signe de vie il y a `alive`. */
const openRun = (job: string, alive: number) =>
  (
    data
      .query('INSERT INTO runs (job, started_at, alive_at) VALUES (?, ?, ?) RETURNING id')
      .get(job, ago(DAY), ago(alive)) as { id: number }
  ).id

const run = (id: number) =>
  data.query('SELECT finished_at, ok, message, alive_at FROM runs WHERE id = ?').get(id) as {
    finished_at: string | null
    ok: number | null
    message: string | null
    alive_at: string
  }

describe('startRun', () => {
  beforeEach(() => data.run('DELETE FROM runs'))

  test('un passage ouvert sans signe de vie depuis plus de 5 min : la tâche démarre, lui est noté interrompu', () => {
    const orphan = openRun('history', 6 * MINUTE)
    const id = startRun(data, 'history')
    expect(id).not.toBeNull()
    const closed = run(orphan)
    expect(closed).toEqual({
      finished_at: closed.alive_at,
      ok: 0,
      message: 'interrompue',
      alive_at: closed.alive_at,
    })
    expect(run(id!)).toMatchObject({ finished_at: null, ok: null, message: null })
  })

  test('un passage qui donne signe de vie, même commencé il y a longtemps : la tâche ne démarre pas', () => {
    const running = openRun('history', 2 * MINUTE)
    expect(startRun(data, 'history')).toBeNull()
    expect(run(running).finished_at).toBeNull()
    expect(data.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 })
  })

  test('le passage en vie d’une autre tâche ne bloque pas celle-ci', () => {
    const prices = openRun('prices', MINUTE)
    expect(startRun(data, 'history')).not.toBeNull()
    expect(run(prices).finished_at).toBeNull()
  })

  test('catalog et history lisent les mêmes pages : l’une en vie bloque l’autre, pas un passage arrêté net', () => {
    const catalog = openRun('catalog', MINUTE)
    expect(startRun(data, 'history')).toBeNull()
    expect(run(catalog).finished_at).toBeNull()
    data.run('DELETE FROM runs')
    openRun('history', MINUTE)
    expect(startRun(data, 'catalog')).toBeNull()
    // Sans signe de vie depuis plus de 5 min : il ne bloque plus l'autre.
    data.run('DELETE FROM runs')
    const orphan = openRun('history', 6 * MINUTE)
    expect(startRun(data, 'catalog')).not.toBeNull()
    expect(run(orphan).finished_at).toBeNull()
    expect(startRun(data, 'images')).not.toBeNull()
  })
})
