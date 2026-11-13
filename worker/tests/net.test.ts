/**
 * Le réseau des tâches (`worker/ingest/net.ts`) : une redirection n'est jamais suivie (la source ne
 * mène que là où on l'a demandée), une réponse lue d'un coup l'est jusqu'à 5 Mo, sa taille annoncée
 * ou non, et un document JSON trop gros n'est pas redemandé. Sans ces bornes, une réponse énorme
 * épuiserait la mémoire du Worker. Jamais le réseau : `fetch` est remplacé.
 */

import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { download, fetchJson, politeFetch, readCapped } from '../ingest/net'

let network: MockInstance<typeof fetch>
beforeEach(() => {
  network = vi.spyOn(globalThis, 'fetch')
})
afterEach(() => network.mockRestore())

/** Une réponse en flux, sans taille annoncée, de ces morceaux (chacun de `size` octets). */
const streamed = (...sizes: number[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const size of sizes) controller.enqueue(new Uint8Array(size))
        controller.close()
      },
    }),
  )

describe('les redirections', () => {
  test('jamais suivies : une réponse 3xx est une erreur, même si l’appel demandait de suivre', async () => {
    network.mockResolvedValue(
      new Response(null, { status: 301, headers: { Location: 'https://ailleurs.example/' } }),
    )
    await expect(download('https://source.example/a')).rejects.toThrow('HTTP 301')
    await politeFetch('https://source.example/a', { redirect: 'follow' })
    expect(network).toHaveBeenCalledTimes(2)
    for (const [, init] of network.mock.calls) expect(init).toMatchObject({ redirect: 'manual' })
  })
})

describe('les lectures plafonnées à 5 Mo', () => {
  const url = 'https://source.example/a'

  test('jusqu’à 5 Mo : lue en entier, en un ou plusieurs morceaux', async () => {
    expect((await readCapped(streamed(5_000_000), url)).byteLength).toBe(5_000_000)
    expect((await readCapped(streamed(2_000_000, 3_000_000), url)).byteLength).toBe(5_000_000)
    expect((await readCapped(new Response('abc'), url)).byteLength).toBe(3)
  })

  test('au-delà, en flux sans taille annoncée : une erreur', async () => {
    await expect(readCapped(streamed(5_000_001), url)).rejects.toThrow('Plus de 5 Mo')
    await expect(readCapped(streamed(2_000_000, 2_000_000, 2_000_000), url)).rejects.toThrow(
      'Plus de 5 Mo',
    )
  })

  test('une taille annoncée de plus de 5 Mo : refusée sans rien lire', async () => {
    const response = new Response('petit', { headers: { 'Content-Length': '6000000' } })
    await expect(readCapped(response, url)).rejects.toThrow('Plus de 5 Mo')
  })

  test('un document JSON trop gros : une erreur, sans le redemander', async () => {
    network.mockImplementation(async () => streamed(6_000_000))
    await expect(fetchJson('https://source.example/a.json')).rejects.toThrow('Plus de 5 Mo')
    expect(network).toHaveBeenCalledTimes(1)
  })
})
