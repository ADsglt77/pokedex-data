/**
 * L'accès à l'API : sans token, aucune donnée (`auth.ts`) ; seul `/v1/health` passe sans. Et l'état
 * des tâches (`status.ts`), que montre la page Données du site : une tâche à la demande n'est
 * jamais en retard, et la surveillance ne compte que celles à rythme.
 */

import { describe, expect, test } from 'bun:test'
import { readClients } from '../src/auth'
import { createApp } from '../src/app'
import type { ServerStatus } from '../src/contract'
import { DAY, HOUR } from '../src/lib/time'
import { testData } from './server'

const TOKEN = 'token-d-essai-de-32-caracteres-au-moins'
const data = testData()
const api = createApp(data, readClients(`pokedex:${TOKEN}`, true))
const get = (path: string, token?: string) =>
  api.handle(
    new Request(`http://localhost${path}`, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  )

/** Les passages des tâches : aucun, puis ceux que pose chaque test. */
function runs(...rows: [job: string, ok: 0 | 1, ago: number][]) {
  data.run('DELETE FROM runs')
  data.run("DELETE FROM sources WHERE name = 'cardmarket'")
  const write = data.query(
    'INSERT INTO runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, ?)',
  )
  for (const [job, ok, ago] of rows) {
    const at = new Date(Date.now() - ago).toISOString()
    write.run(job, at, at, ok)
  }
}

describe('le token', () => {
  test('sans token, ou un autre : 401 sans corps, sur chaque route, une adresse inconnue aussi', async () => {
    for (const path of [
      '/v1/status',
      '/v1/species',
      '/v1/catalog/sets',
      '/v1/prices?ids=1',
      '/v1/histories?ids=1',
      '/v1/wants?ids=1',
      '/v1/images/species/1.png',
      '/v1/inconnue',
    ]) {
      for (const token of [undefined, 'faux', `${TOKEN}x`]) {
        const response = await get(path, token)
        expect(response.status).toBe(401)
        expect(await response.text()).toBe('')
      }
    }
  })

  test('avec le token : la réponse', async () => {
    runs()
    expect((await get('/v1/status', TOKEN)).status).toBe(200)
    expect((await get('/v1/inconnue', TOKEN)).status).toBe(404)
  })

  test('/v1/health passe sans token', async () => {
    runs()
    expect([200, 503]).toContain((await get('/v1/health')).status)
  })

  test('un token trop court ou mal écrit : l’API ne démarre pas', () => {
    expect(() => readClients('pokedex:court', true)).toThrow('moins de 32 caractères')
    expect(() => readClients('pokedex', false)).toThrow('nom:token')
    expect(readClients('pokedex:court, autre:x', false).map(({ name }) => name)).toEqual([
      'pokedex',
      'autre',
    ])
  })
})

describe('l’état des tâches', () => {
  const status = async () => (await (await get('/v1/status', TOKEN)).json()) as ServerStatus
  const stateOf = (current: ServerStatus, job: string) =>
    current.jobs.find((row) => row.job === job)!.state

  test('chaque tâche et son état, sans les détails internes', async () => {
    runs(
      ['prices', 1, HOUR],
      ['species', 1, 61 * DAY],
      ['catalog', 1, 90 * DAY],
      ['backups', 0, HOUR],
    )
    const current = await status()
    expect(current.jobs.map(({ job }) => job)).toEqual([
      'species',
      'catalog',
      'images',
      'prices',
      'history',
      'backups',
    ])
    expect(current.jobs.find((row) => row.job === 'catalog')).toEqual({
      job: 'catalog',
      label: 'Catalogue',
      state: 'ok',
    })
    expect(stateOf(current, 'prices')).toBe('ok')
    expect(stateOf(current, 'species')).toBe('late')
    // À la demande : jamais en retard, même passée il y a longtemps.
    expect(stateOf(current, 'catalog')).toBe('ok')
    expect(stateOf(current, 'images')).toBe('never')
    expect(stateOf(current, 'backups')).toBe('failed')
  })

  test('une tâche planifiée jamais passée est en retard', async () => {
    runs(['prices', 1, HOUR], ['backups', 1, HOUR])
    const current = await status()
    expect(stateOf(current, 'catalog')).toBe('never')
    expect(stateOf(current, 'images')).toBe('never')
    expect(stateOf(current, 'species')).toBe('late')
  })

  test('des prix figés : la tâche réussit, mais le guide a plus de deux jours', async () => {
    runs(['prices', 1, HOUR])
    data
      .query("INSERT INTO sources (name, stamp, date) VALUES ('cardmarket', 'x', ?)")
      .run(new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10))
    expect(stateOf(await status(), 'prices')).toBe('frozen')
  })

  test('la surveillance : 503 pour une tâche à rythme en retard, jamais pour une à la demande', async () => {
    runs(['species', 1, HOUR], ['prices', 1, HOUR], ['backups', 1, HOUR])
    expect((await get('/v1/health')).status).toBe(200)
    runs(['species', 1, HOUR], ['prices', 1, 13 * HOUR], ['backups', 1, HOUR])
    const late = await get('/v1/health')
    expect(late.status).toBe(503)
    expect(await late.json()).toEqual({ ok: false, late: ['prices'] })
  })
})
