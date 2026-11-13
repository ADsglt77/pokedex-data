/**
 * Les images servies (`worker/images.ts`, depuis R2) : le scan d'une carte et le logo d'une série,
 * lus dans les images de l'importateur (`IMPORTS`, jamais `FILES`), le scan `md` sa petite image ou,
 * tant qu'elle manque, la grande ; un chemin français ne mène qu'à une image française ; seulement
 * un chemin de la forme exacte des clés de l'importateur (`_XX`, ni `.` ni `..`), sinon le logo
 * d'une série serait servi pour une carte ; une image absente, 404 sans rien télécharger. Les
 * images des Pokémon (`FILES`), l'illustration en WebP ou, tant qu'elle n'est pas convertie, son
 * PNG, chacune avec son type. Et leur copie par la tâche `sprites` : ses adresses d'origine,
 * seulement un PNG de 5 Mo au plus, seulement ce qui manque. Jamais le réseau : `fetch` est
 * remplacé.
 */

import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { artworkSource, artworkUrl, imagePathOf, spriteUrl } from '@/lib/image-paths'
import { app } from '../app'
import type { Step } from '../ingest/workflow'
import { alive, emptyFiles } from './helpers'

// `politeFetch` sans ses 100 ms d'attente, et la tâche `sprites` pour deux Pokémon seulement ;
// `sprites.ts`, déjà chargé par l'entrée du Worker, rechargé pour les prendre.
vi.mock(import('../ingest/net'), async (original) => ({
  ...(await original()),
  politeFetch: (url, init) => fetch(url, init),
}))
vi.mock(import('@/config/pokedex'), async (original) => ({
  ...(await original()),
  SPECIES_IDS: [25, 26],
}))
vi.resetModules()
const { mirror, sprites } = await import('../ingest/sprites')

/** Le contenu d'une image d'essai (lue en octets : workerd prévient pour une image lue en texte). */
const text = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)

/** Ce que sert l'API : le contenu de l'image et son type, ou le statut d'une réponse sans image. */
async function served(path: string) {
  const response = await app.request(`/v1${path}`)
  if (response.status !== 200) return response.status
  return `${text(await response.arrayBuffer())} (${response.headers.get('content-type')})`
}

beforeEach(emptyFiles)

describe('les images des cartes et des séries', () => {
  test('le scan hd : la grande image ; md : la petite, ou la grande tant qu’elle manque ; gardés un an, sauf ce repli, un jour', async () => {
    await env.IMPORTS.put('cards/fr/sv03.5/sv03.5-006.webp', 'grande')
    await env.IMPORTS.put('cards/fr/sv03.5/sv03.5-007.webp', 'grande 7')
    await env.IMPORTS.put('cards/fr/sv03.5/sv03.5-006.low.webp', 'petite')
    expect(await served('/images/cards/fr/sv03.5/sv03.5-006-hd.webp')).toBe('grande (image/webp)')
    expect(await served('/images/cards/fr/sv03.5/sv03.5-006-md.webp')).toBe('petite (image/webp)')
    expect(await served('/images/cards/fr/sv03.5/sv03.5-007-md.webp')).toBe('grande 7 (image/webp)')
    expect(await served('/images/cards/fr/sv03.5/sv03.5-008-md.webp')).toBe(404)
    const cacheOf = async (path: string) =>
      (await app.request(`/v1${path}`)).headers.get('cache-control')
    const year = 'public, max-age=31536000, immutable'
    expect(await cacheOf('/images/cards/fr/sv03.5/sv03.5-006-hd.webp')).toBe(year)
    expect(await cacheOf('/images/cards/fr/sv03.5/sv03.5-006-md.webp')).toBe(year)
    // La petite image viendra : la grande à sa place n'est pas gardée un an.
    expect(await cacheOf('/images/cards/fr/sv03.5/sv03.5-007-md.webp')).toBe(
      'public, max-age=86400',
    )
  })

  test('le logo d’une série : son `_logo.webp` ; un chemin français ne mène qu’à une image française', async () => {
    await env.IMPORTS.put('cards/fr/sv03.5/_logo.webp', 'logo français')
    await env.IMPORTS.put('cards/ja/SV2a/SV2a-001.webp', 'scan japonais')
    await env.IMPORTS.put('cards/ja/SV2a/_logo.webp', 'logo japonais')
    expect(await served('/images/sets/fr/sv03.5.webp')).toBe('logo français (image/webp)')
    expect(await served('/images/sets/ja/SV2a.webp')).toBe('logo japonais (image/webp)')
    expect(await served('/images/cards/ja/SV2a/SV2a-001-hd.webp')).toBe(
      'scan japonais (image/webp)',
    )
    expect(await served('/images/sets/ja/sv03.5.webp')).toBe(404)
    expect(await served('/images/sets/fr/SV2a.webp')).toBe(404)
    expect(await served('/images/cards/fr/SV2a/SV2a-001-hd.webp')).toBe(404)
  })

  test('les parties encodées comme les clés de l’importateur : `_XX` en majuscules ; jamais le logo pour une carte', async () => {
    await env.IMPORTS.put('cards/ja/SM1_2B/SM1_2B-001.webp', 'scan SM1+')
    await env.IMPORTS.put('cards/fr/sv01/_logo.webp', 'logo')
    expect(await served('/images/cards/ja/SM1_2B/SM1_2B-001-hd.webp')).toBe(
      'scan SM1+ (image/webp)',
    )
    expect(await served('/images/cards/ja/SM1_2b/SM1_2b-001-hd.webp')).toBe(404)
    expect(await served('/images/cards/ja/SM1+/SM1+-001-hd.webp')).toBe(404)
    expect(await served('/images/cards/fr/sv01/_logo-hd.webp')).toBe(404)
  })

  test('seulement un chemin de la forme exacte : ni `.` ni `..`, ni autre langue, ni autre taille', () => {
    expect(imagePathOf('/images/cards/fr/sv01/sv01-001-md.webp')).toEqual({
      kind: 'card',
      parts: ['fr', 'sv01', 'sv01-001', 'md'],
    })
    for (const path of [
      '/images/cards/fr/../sv01-001-md.webp',
      '/images/cards/fr/./sv01-001-md.webp',
      '/images/cards/fr/sv01/..-md.webp',
      '/images/sets/fr/...webp',
      '/images/sets/fr/..webp',
      '/images/cards/en/sv01/sv01-001-md.webp',
      '/images/cards/fr/sv01/sv01-001-sd.webp',
      '/images/cards/fr/sv01/sv01-001.webp',
      '/images/cards/fr/sv01/sous/sv01-001-md.webp',
      '/images/cards/fr/sv 01/sv01-001-md.webp',
      '/images/sets/fr/sv01-md.webp/x',
    ]) {
      expect(imagePathOf(path)).toBeNull()
    }
  })

  test('chaque image dans son R2 : une carte jamais lue dans `FILES`, un Pokémon jamais dans `IMPORTS`', async () => {
    await env.FILES.put('cards/fr/sv01/sv01-001.webp', 'pas de l’importateur')
    await env.IMPORTS.put('images/species/25.png', 'pas de la tâche')
    expect(await served('/images/cards/fr/sv01/sv01-001-hd.webp')).toBe(404)
    expect(await served(spriteUrl(25))).toBe(404)
  })
})

describe('les images des Pokémon', () => {
  test('le sprite et l’illustration : le WebP, ou son PNG tant qu’il n’est pas converti, chacun avec son type', async () => {
    await env.FILES.put('images/species/25.png', 'sprite')
    await env.FILES.put('images/species/artwork/25.png', 'illustration PNG')
    expect(await served(spriteUrl(25))).toBe('sprite (image/png)')
    expect(await served(artworkUrl(25))).toBe('illustration PNG (image/png)')
    expect(await served(artworkSource(25))).toBe('illustration PNG (image/png)')
    const cacheOf = async (path: string) =>
      (await app.request(`/v1${path}`)).headers.get('cache-control')
    // Le PNG à la place du WebP : un jour seulement ; demandé pour lui-même, un an.
    expect(await cacheOf(artworkUrl(25))).toBe('public, max-age=86400')
    expect(await cacheOf(artworkSource(25))).toBe('public, max-age=31536000, immutable')
    await env.FILES.put('images/species/artwork/25.webp', 'illustration WebP')
    expect(await served(artworkUrl(25))).toBe('illustration WebP (image/webp)')
    expect(await cacheOf(artworkUrl(25))).toBe('public, max-age=31536000, immutable')
    expect(await served(artworkUrl(26))).toBe(404)
  })

  test('seulement un Pokémon du Pokédex, de 1 à 1 025', async () => {
    await env.FILES.put('images/species/1026.png', 'inconnu')
    await env.FILES.put('images/species/0.png', 'zéro')
    expect(await served('/images/species/1026.png')).toBe(404)
    expect(await served('/images/species/0.png')).toBe(404)
  })
})

describe('la tâche `sprites`', () => {
  let network: MockInstance<typeof fetch>
  beforeEach(() => {
    network = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => network.mockRestore())

  const png = (body: BodyInit = 'image', type = 'image/png') =>
    new Response(body, { headers: { 'Content-Type': type } })
  const step: Step = (_name, work) => work(alive)
  const base = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'

  test('le sprite et le PNG de l’illustration de chaque Pokémon, d’après PokéAPI ; seulement ce qui manque', async () => {
    await env.FILES.put('images/species/26.png', 'déjà là')
    network.mockImplementation(async () => png())
    await sprites(step)
    // Deux Pokémon à la fois : dans l'ordre de leurs adresses.
    expect(network.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `${base}/25.png`,
      `${base}/other/official-artwork/25.png`,
      `${base}/other/official-artwork/26.png`,
    ])
    expect(await served(spriteUrl(25))).toBe('image (image/png)')
    expect(await served(spriteUrl(26))).toBe('déjà là (image/png)')
    expect(await served(artworkUrl(26))).toBe('image (image/png)')
  })

  test('seulement un PNG de 5 Mo au plus : sinon une erreur, rien d’écrit ; un 404, aucune image', async () => {
    const path = spriteUrl(25)
    const url = 'https://source.example/25.png'
    for (const type of ['image/webp', 'text/html', '']) {
      network.mockResolvedValueOnce(png('<html>', type))
      await expect(mirror(path, url)).rejects.toThrow('Pas une image PNG')
    }
    network.mockResolvedValueOnce(png(new Uint8Array(5_000_001)))
    await expect(mirror(path, url)).rejects.toThrow('Plus de 5 Mo')
    network.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect(await mirror(path, url)).toBe(false)
    expect(await served(path)).toBe(404)
    network.mockResolvedValueOnce(png('image', 'image/png; charset=binary'))
    expect(await mirror(path, url)).toBe(true)
    expect(await served(path)).toBe('image (image/png)')
  })

  test('une image en erreur n’empêche pas les autres : la tâche échoue à la fin', async () => {
    network.mockImplementation(async (url) =>
      String(url) === `${base}/25.png` ? new Response(null, { status: 503 }) : png(),
    )
    await expect(sprites(step)).rejects.toThrow('1 image en erreur')
    expect(await served(spriteUrl(25))).toBe(404)
    expect(await served(artworkUrl(25))).toBe('image (image/png)')
    expect(await served(spriteUrl(26))).toBe('image (image/png)')
  })
})
