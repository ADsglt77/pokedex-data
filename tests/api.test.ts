/**
 * L'accès à l'API : sans token, aucune donnée (`auth.ts`) ; seul `/v1/health` passe sans. Sur
 * l'entrée d'Internet (`api.pokecodex.fr`, `limits.ts`), le token toujours, et une limite par
 * adresse : une limite fausse bloquerait un client, ou laisserait un afflux occuper l'API. Et l'état
 * des tâches (`status.ts`), que montre la page Données du site : une tâche à la demande n'est
 * jamais en retard, un passage arrêté net est un échec, et la surveillance ne compte que celles à
 * rythme. Et les routes du catalogue : chaque langue rend ses réponses (`/v1/catalog/…` les
 * japonaises, `/v1/catalog/fr/…` les françaises), sans jamais mêler les unes aux autres.
 */

import { describe, expect, test } from 'bun:test'
import { readClients } from '../src/auth'
import { createApp } from '../src/app'
import type { ServerStatus } from '../src/contract'
import { publicLimits } from '../src/limits'
import { saveSnapshot } from '../src/snapshots'
import { DAY, HOUR, MINUTE } from '../src/lib/time'
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
      '/v1/catalog/fr/sets',
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

  test('un token qui contient « : » est gardé entier : son début ne suffit pas', async () => {
    const entier = `${TOKEN}:suite`
    const app = createApp(data, readClients(`moi:${entier}`, true))
    const status = async (token: string) =>
      (
        await app.handle(
          new Request('http://localhost/v1/status', {
            headers: { Authorization: `Bearer ${token}` },
          }),
        )
      ).status
    runs()
    expect(await status(entier)).toBe(200)
    expect(await status(TOKEN)).toBe(401)
  })
})

describe('l’entrée d’Internet (api.pokecodex.fr)', () => {
  let now = 0
  const entry = createApp(
    data,
    readClients(`moi:${TOKEN}`, true),
    publicLimits(() => now),
  )
  /** `token` : `null`, sans token. */
  const from = (address: string, path: string, token: string | null = TOKEN) =>
    entry.handle(
      new Request(`http://localhost${path}`, {
        headers: {
          'x-forwarded-for': address,
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
      }),
    )
  /** Les statuts de `count` demandes d'une adresse, au même instant. */
  const burst = async (count: number, address: string, path: string) => {
    const statuses: number[] = []
    for (let i = 0; i < count; i++) statuses.push((await from(address, path)).status)
    return statuses
  }

  test('le token y est exigé, comme sur le réseau du site', async () => {
    runs()
    expect((await from('203.0.113.1', '/v1/status', null)).status).toBe(401)
    expect((await from('203.0.113.1', '/v1/status', 'faux')).status).toBe(401)
    expect((await from('203.0.113.1', '/v1/status')).status).toBe(200)
  })

  test('300 d’un coup par adresse, puis 429 sans corps et Retry-After ; une autre adresse passe', async () => {
    runs()
    expect((await burst(300, '203.0.113.2', '/v1/status')).every((s) => s === 200)).toBe(true)
    const over = await from('203.0.113.2', '/v1/status')
    expect(over.status).toBe(429)
    expect(over.headers.get('retry-after')).toBe('1')
    expect(await over.text()).toBe('')
    // Sans token non plus : la limite passe avant lui.
    expect((await from('203.0.113.2', '/v1/status', null)).status).toBe(429)
    expect((await from('203.0.113.3', '/v1/status')).status).toBe(200)
  })

  test('le seau se remplit : 20 par seconde', async () => {
    runs()
    await burst(300, '203.0.113.4', '/v1/status')
    expect((await from('203.0.113.4', '/v1/status')).status).toBe(429)
    now += 1000
    expect((await burst(20, '203.0.113.4', '/v1/status')).every((s) => s === 200)).toBe(true)
    expect((await from('203.0.113.4', '/v1/status')).status).toBe(429)
  })

  test('les routes coûteuses : 10 d’un coup, sans gêner les autres', async () => {
    const heavy = await burst(11, '203.0.113.5', '/v1/histories?ids=1')
    expect(heavy.slice(0, 10).every((s) => s !== 429)).toBe(true)
    expect(heavy[10]).toBe(429)
    expect((await from('203.0.113.5', '/v1/wants?ids=1')).status).toBe(429)
    runs()
    expect((await from('203.0.113.5', '/v1/status')).status).toBe(200)
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
      ['history', 0, HOUR],
      // Une tâche retirée (les sauvegardes, octobre 2026) : ses passages restent, sans compter.
      ['backups', 0, HOUR],
    )
    const current = await status()
    expect(current.jobs.map(({ job }) => job)).toEqual([
      'species',
      'catalog',
      'images',
      'prices',
      'history',
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
    expect(stateOf(current, 'history')).toBe('failed')
  })

  test('une tâche planifiée jamais passée est en retard', async () => {
    runs(['prices', 1, HOUR])
    const current = await status()
    expect(stateOf(current, 'catalog')).toBe('never')
    expect(stateOf(current, 'images')).toBe('never')
    expect(stateOf(current, 'species')).toBe('late')
  })

  test('un passage arrêté net (sans signe de vie depuis 5 min) : en échec ; un en cours : l’état d’avant', async () => {
    runs(['catalog', 1, DAY])
    const open = data.query('INSERT INTO runs (job, started_at, alive_at) VALUES (?, ?, ?)')
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    open.run('history', ago(DAY), ago(10 * MINUTE))
    open.run('catalog', ago(HOUR), ago(MINUTE))
    open.run('images', ago(HOUR), ago(MINUTE))
    const current = await status()
    expect(stateOf(current, 'history')).toBe('failed')
    expect(stateOf(current, 'catalog')).toBe('ok')
    expect(stateOf(current, 'images')).toBe('never')
  })

  test('des prix figés : la tâche réussit, mais le guide a plus de deux jours', async () => {
    runs(['prices', 1, HOUR])
    data
      .query("INSERT INTO sources (name, stamp, date) VALUES ('cardmarket', 'x', ?)")
      .run(new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10))
    expect(stateOf(await status(), 'prices')).toBe('frozen')
  })

  test('la surveillance : 503 pour une tâche à rythme en retard, jamais pour une à la demande', async () => {
    // Sans passage d'une tâche retirée (les sauvegardes) : elle ne compte plus.
    runs(['species', 1, HOUR], ['prices', 1, HOUR])
    expect((await get('/v1/health')).status).toBe(200)
    runs(['species', 1, HOUR], ['prices', 1, 13 * HOUR])
    const late = await get('/v1/health')
    expect(late.status).toBe(503)
    expect(await late.json()).toEqual({ ok: false, late: ['prices'] })
  })
})

describe('le catalogue de chaque langue', () => {
  const answer = async (path: string) => {
    const response = await get(path, TOKEN)
    expect(response.status).toBe(200)
    return response.json()
  }

  test('les routes françaises servent les réponses françaises, les japonaises restent', async () => {
    saveSnapshot(data, 'catalog/sets', { langue: 'ja', route: 'sets' })
    saveSnapshot(data, 'catalog/fr/sets', { langue: 'fr', route: 'sets' })
    saveSnapshot(data, 'catalog/sets/SV2A', { langue: 'ja', route: 'set' })
    saveSnapshot(data, 'catalog/fr/sets/MEG', { langue: 'fr', route: 'set' })
    saveSnapshot(data, 'catalog/species/25', { langue: 'ja', route: 'species' })
    saveSnapshot(data, 'catalog/fr/species/25', { langue: 'fr', route: 'species' })
    expect(await answer('/v1/catalog/sets')).toEqual({ langue: 'ja', route: 'sets' })
    expect(await answer('/v1/catalog/fr/sets')).toEqual({ langue: 'fr', route: 'sets' })
    expect(await answer('/v1/catalog/sets/SV2A')).toEqual({ langue: 'ja', route: 'set' })
    expect(await answer('/v1/catalog/fr/sets/MEG')).toEqual({ langue: 'fr', route: 'set' })
    expect(await answer('/v1/catalog/species/25')).toEqual({ langue: 'ja', route: 'species' })
    expect(await answer('/v1/catalog/fr/species/25')).toEqual({ langue: 'fr', route: 'species' })
  })

  test('une réponse absente de sa langue : 404 sans corps, jamais celle de l’autre', async () => {
    saveSnapshot(data, 'catalog/sets/SV2A', { langue: 'ja' })
    saveSnapshot(data, 'catalog/fr/sets/MEG', { langue: 'fr' })
    for (const path of [
      '/v1/catalog/fr/sets/INCONNU',
      '/v1/catalog/fr/sets/SV2A',
      '/v1/catalog/sets/MEG',
      '/v1/catalog/fr/species/1',
    ]) {
      const response = await get(path, TOKEN)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    }
  })

  test('un paramètre hors schéma : 422, même si une réponse existe sous ce nom', async () => {
    for (const [name, path] of [
      ['catalog/sets/a b', '/v1/catalog/sets/a%20b'],
      ['catalog/fr/sets/a b', '/v1/catalog/fr/sets/a%20b'],
      ['catalog/species/1026', '/v1/catalog/species/1026'],
      ['catalog/fr/species/1026', '/v1/catalog/fr/species/1026'],
      ['catalog/fr/species/0', '/v1/catalog/fr/species/0'],
    ] as const) {
      saveSnapshot(data, name, { name })
      expect((await get(path, TOKEN)).status).toBe(422)
    }
  })
})
