/**
 * L'accès à l'API. Sur l'entrée d'Internet (`api.pokecodex.fr`, l'entrée par défaut du Worker) :
 * https seulement, lecture seule, les en-têtes d'une API sur chaque réponse (rien à afficher ni à indexer) ;
 * sans token, aucune donnée (`auth.ts`), seul `/v1/health` passe sans ; avant le token, une limite
 * par adresse (`limits.ts`, comptée par Cloudflare) : fausse, elle bloquerait un client, ou
 * laisserait un afflux occuper l'API. L'entrée du site (sa liaison de service) : ni token ni
 * limite. Et l'état des tâches (`status.ts`), que montre la page Réglages du site : une tâche à la
 * demande n'est jamais en retard, un passage arrêté net est un échec, et la surveillance ne compte
 * que celles à rythme. Et les routes du catalogue : chaque langue rend ses réponses
 * (`/v1/catalog/…` les japonaises, `/v1/catalog/fr/…` les françaises), sans jamais mêler les unes
 * aux autres ; une réponse inchangée, 304.
 */

import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, test, vi } from 'vitest'
import type { ServerStatus } from '@/contract'
import { DAY, HOUR, MINUTE } from '@/lib/time'
import { readClients } from '../auth'
import worker, { SiteEntrypoint } from '../index'

/** Les tokens des clients de ces tests (`vitest.config.ts`). */
const TOKEN = 'token-d-essai-de-32-caracteres-au-moins'
const OTHER = 'autre-token-de-32-caracteres-au-moins:suite'

/** Une demande à l'entrée d'Internet, de l'adresse `address` ; `token` : `null`, sans token. */
const get = (path: string, token: string | null = TOKEN, address = '203.0.113.1') =>
  worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: {
        'cf-connecting-ip': address,
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
    }),
  )

/** Les passages des tâches : aucun, puis ceux que pose chaque test. */
async function runs(...rows: [job: string, ok: 0 | 1, ago: number][]) {
  const write = env.DB.prepare(
    'INSERT INTO runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, ?)',
  )
  await env.DB.batch([
    env.DB.prepare('DELETE FROM runs'),
    env.DB.prepare("DELETE FROM sources WHERE name = 'cardmarket'"),
    ...rows.map(([job, ok, ago]) => {
      const at = new Date(Date.now() - ago).toISOString()
      return write.bind(job, at, at, ok)
    }),
  ])
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
      for (const token of [null, 'faux', `${TOKEN}x`]) {
        const response = await get(path, token)
        expect(response.status).toBe(401)
        expect(await response.text()).toBe('')
      }
    }
  })

  test('avec le token : la réponse', async () => {
    await runs()
    expect((await get('/v1/status')).status).toBe(200)
    expect((await get('/v1/inconnue')).status).toBe(404)
  })

  test('/v1/health passe sans token', async () => {
    await runs()
    expect([200, 503]).toContain((await get('/v1/health', null)).status)
  })

  test('un token trop court ou mal écrit : le Worker ne démarre pas', () => {
    expect(() => readClients('pokedex:court')).toThrow('moins de 32 caractères')
    expect(() => readClients('pokedex')).toThrow('nom:token')
    expect(readClients(`pokedex:${TOKEN}, autre:${OTHER}`).map(({ name }) => name)).toEqual([
      'pokedex',
      'autre',
    ])
  })

  test('un token qui contient « : » est gardé entier : son début ne suffit pas', async () => {
    await runs()
    expect((await get('/v1/status', OTHER)).status).toBe(200)
    expect((await get('/v1/status', OTHER.split(':')[0]!)).status).toBe(401)
  })

  test('lecture seule : tout autre verbe, 405, même avec le token', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/v1/status', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.1', Authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(response.status).toBe(405)
  })

  test('en http, 301 vers https, avant même le token', async () => {
    const response = await worker.fetch(
      new Request('http://api.pokecodex.fr/v1/status?x=1', {
        headers: { 'cf-connecting-ip': '203.0.113.1' },
      }),
    )
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('https://api.pokecodex.fr/v1/status?x=1')
    expect(response.headers.get('strict-transport-security')).not.toBeNull()
  })

  test('les en-têtes d’une API sur chaque réponse, refusée ou non', async () => {
    await runs()
    for (const response of [await get('/v1/status'), await get('/v1/status', null)]) {
      expect(response.headers.get('strict-transport-security')).toBe(
        'max-age=31536000; includeSubDomains',
      )
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      )
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    }
  })
})

describe('les limites de l’entrée d’Internet', () => {
  test('par adresse, avant le token : au-delà, 429 sans corps et Retry-After ; une autre adresse passe', async () => {
    await runs()
    const any = vi
      .spyOn(env.ANY_LIMIT, 'limit')
      .mockImplementation(async ({ key }) => ({ success: key !== '203.0.113.2' }))
    try {
      const over = await get('/v1/status', TOKEN, '203.0.113.2')
      expect(over.status).toBe(429)
      expect(over.headers.get('retry-after')).toBe('10')
      expect(await over.text()).toBe('')
      // Sans token non plus : la limite passe avant lui.
      expect((await get('/v1/status', null, '203.0.113.2')).status).toBe(429)
      expect((await get('/v1/status', TOKEN, '203.0.113.3')).status).toBe(200)
      expect(any).toHaveBeenCalledWith({ key: '203.0.113.3' })
    } finally {
      any.mockRestore()
    }
  })

  test('les routes coûteuses ont leur propre limite, sans gêner les autres', async () => {
    await runs()
    const heavy = vi.spyOn(env.HEAVY_LIMIT, 'limit').mockResolvedValue({ success: false })
    try {
      expect((await get('/v1/histories?ids=1')).status).toBe(429)
      expect((await get('/v1/wants?ids=1')).status).toBe(429)
      expect((await get('/v1/status')).status).toBe(200)
      expect(heavy).toHaveBeenCalledTimes(2)
    } finally {
      heavy.mockRestore()
    }
  })

  test('l’entrée du site : ni token ni limite', async () => {
    await runs()
    const any = vi.spyOn(env.ANY_LIMIT, 'limit').mockResolvedValue({ success: false })
    try {
      const site = new SiteEntrypoint(createExecutionContext(), env)
      expect((await site.fetch(new Request('http://localhost/v1/status'))).status).toBe(200)
      expect(any).not.toHaveBeenCalled()
    } finally {
      any.mockRestore()
    }
  })
})

describe('l’état des tâches', () => {
  const status = async () => (await (await get('/v1/status')).json()) as ServerStatus
  const stateOf = (current: ServerStatus, job: string) =>
    current.jobs.find((row) => row.job === job)!.state

  test('chaque tâche et son état, sans les détails internes', async () => {
    await runs(
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
    await runs(['prices', 1, HOUR])
    const current = await status()
    expect(stateOf(current, 'catalog')).toBe('never')
    expect(stateOf(current, 'images')).toBe('never')
    expect(stateOf(current, 'species')).toBe('late')
  })

  test('un passage arrêté net (sans signe de vie depuis 5 min) : en échec ; un en cours : l’état d’avant', async () => {
    await runs(['catalog', 1, DAY])
    const open = env.DB.prepare('INSERT INTO runs (job, started_at, alive_at) VALUES (?, ?, ?)')
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    await env.DB.batch([
      open.bind('history', ago(DAY), ago(10 * MINUTE)),
      open.bind('catalog', ago(HOUR), ago(MINUTE)),
      open.bind('images', ago(HOUR), ago(MINUTE)),
    ])
    const current = await status()
    expect(stateOf(current, 'history')).toBe('failed')
    expect(stateOf(current, 'catalog')).toBe('ok')
    expect(stateOf(current, 'images')).toBe('never')
  })

  test('des prix figés : la tâche réussit, mais le guide a plus de deux jours', async () => {
    await runs(['prices', 1, HOUR])
    await env.DB.prepare("INSERT INTO sources (name, stamp, date) VALUES ('cardmarket', 'x', ?)")
      .bind(new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10))
      .run()
    expect(stateOf(await status(), 'prices')).toBe('frozen')
  })

  test('la surveillance : 503 pour une tâche à rythme en retard, jamais pour une à la demande', async () => {
    await runs(['species', 1, HOUR], ['prices', 1, HOUR])
    expect((await get('/v1/health', null)).status).toBe(200)
    await runs(['species', 1, HOUR], ['prices', 1, 13 * HOUR])
    const late = await get('/v1/health', null)
    expect(late.status).toBe(503)
    expect(await late.json()).toEqual({ ok: false, late: ['prices'] })
  })
})

describe('le catalogue de chaque langue', () => {
  /** Une réponse calculée par une tâche, dans R2. */
  const snapshot = (name: string, body: unknown) =>
    env.FILES.put(`snapshots/${name}.json`, JSON.stringify(body))
  const answer = async (path: string) => {
    const response = await get(path)
    expect(response.status).toBe(200)
    return response.json()
  }

  test('les routes françaises servent les réponses françaises, les japonaises restent', async () => {
    await snapshot('catalog/sets', { langue: 'ja', route: 'sets' })
    await snapshot('catalog/fr/sets', { langue: 'fr', route: 'sets' })
    await snapshot('catalog/sets/SV2A', { langue: 'ja', route: 'set' })
    await snapshot('catalog/fr/sets/MEG', { langue: 'fr', route: 'set' })
    await snapshot('catalog/species/25', { langue: 'ja', route: 'species' })
    await snapshot('catalog/fr/species/25', { langue: 'fr', route: 'species' })
    expect(await answer('/v1/catalog/sets')).toEqual({ langue: 'ja', route: 'sets' })
    expect(await answer('/v1/catalog/fr/sets')).toEqual({ langue: 'fr', route: 'sets' })
    expect(await answer('/v1/catalog/sets/SV2A')).toEqual({ langue: 'ja', route: 'set' })
    expect(await answer('/v1/catalog/fr/sets/MEG')).toEqual({ langue: 'fr', route: 'set' })
    expect(await answer('/v1/catalog/species/25')).toEqual({ langue: 'ja', route: 'species' })
    expect(await answer('/v1/catalog/fr/species/25')).toEqual({ langue: 'fr', route: 'species' })
  })

  test('une réponse absente de sa langue : 404 sans corps, jamais celle de l’autre', async () => {
    await snapshot('catalog/sets/SV2A', { langue: 'ja' })
    await snapshot('catalog/fr/sets/MEG', { langue: 'fr' })
    for (const path of [
      '/v1/catalog/fr/sets/INCONNU',
      '/v1/catalog/fr/sets/SV2A',
      '/v1/catalog/sets/MEG',
      '/v1/catalog/fr/species/1',
    ]) {
      const response = await get(path)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    }
  })

  test('une réponse inchangée depuis la dernière demande : 304, sans corps', async () => {
    await snapshot('species', [{ id: 1 }])
    const first = await get('/v1/species')
    const etag = first.headers.get('etag')!
    const again = (sent: string) =>
      worker.fetch(
        new Request('http://localhost/v1/species', {
          headers: { Authorization: `Bearer ${TOKEN}`, 'If-None-Match': sent },
        }),
      )
    expect((await again(etag)).status).toBe(304)
    // Affaibli par un relais qui compresse la réponse : le même.
    expect((await again(`W/${etag}`)).status).toBe(304)
    // Changée par la tâche : la nouvelle.
    await snapshot('species', [{ id: 2 }])
    const changed = await again(etag)
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual([{ id: 2 }])
  })

  test('un paramètre hors schéma : 422, même si une réponse existe sous ce nom', async () => {
    for (const [name, path] of [
      ['catalog/sets/a b', '/v1/catalog/sets/a%20b'],
      ['catalog/fr/sets/a b', '/v1/catalog/fr/sets/a%20b'],
      ['catalog/species/1026', '/v1/catalog/species/1026'],
      ['catalog/fr/species/1026', '/v1/catalog/fr/species/1026'],
      ['catalog/fr/species/0', '/v1/catalog/fr/species/0'],
    ] as const) {
      await snapshot(name, { name })
      expect((await get(path)).status).toBe(422)
    }
  })
})
