/**
 * Les images servies (`worker/images.ts`, depuis R2) : les chemins français et japonais d'une même
 * série (SVP) mènent chacun à leur image, plausibles seulement si leur langue a la série (sinon une
 * carte française montrerait le scan d'une japonaise), et jusqu'au plus grand rang des cartes de
 * la série dans cette langue ; une image qui n'est pas copiée répond 404, sans rien télécharger
 * (la tâche `images` les copie toutes d'avance).
 *
 * Et leur copie (`worker/ingest/images.ts`) : l'adresse d'origine de chaque chemin (le scan
 * français est celui du dossier `FR`, jamais celui sans langue, qui n'est pas lui). Après une
 * renumérotation d'une série par la source, la tâche recopie le scan de chaque carte cherchée (le
 * fichier de son rang était celui d'une autre carte), ne garde aucun fichier pour une carte que la
 * source n'a pas (ni à sa recherche de la semaine suivante), et ne note jamais une carte que le
 * catalogue a déplacée pendant la copie. Jamais le réseau : `fetch` est remplacé.
 */

import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import type { CardLanguage } from '@/contract'
import { cardScan, setLogo } from '@/lib/image-paths'
import { app } from '../app'
import { saveSeries } from '../ingest/catalog'
import { images, mirror } from '../ingest/images'
import type { PokecardexSeries } from '../ingest/pokecardex'
import type { Step } from '../ingest/workflow'

/** Le nombre de cartes de la série SVP dans chaque langue. */
const CARDS: Record<CardLanguage, number> = { ja: 1, fr: 3 }

/** Seules ces langues ont la série SVP (ses cartes : de 1 à `CARDS[langue]`), et aucune rareté. */
async function catalog(...languages: CardLanguage[]) {
  const set = env.DB.prepare(
    `INSERT INTO sets (lang, id, name, released, read_at)
     VALUES (?, 'SVP', 'Promos', '2023-01-01', '2026-10-22T10:00:00.000Z')`,
  )
  const card = env.DB.prepare(
    `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
     VALUES (?, ?, 'SVP', ?, ?, 'Carte', 0, '2026-10-22T10:00:00.000Z')`,
  )
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rarities'),
    env.DB.prepare('DELETE FROM cards'),
    env.DB.prepare('DELETE FROM sets'),
    ...languages.flatMap((lang) => [
      set.bind(lang),
      ...Array.from({ length: CARDS[lang] }, (_, index) =>
        card.bind(lang, index + 1, String(index + 1), index + 1),
      ),
    ]),
  ])
}

/** Une image copiée, de ce contenu. */
const put = (path: string, content: string) => env.FILES.put(path.slice(1), content)

/** Le contenu d'une image d'essai (lue en octets : workerd prévient pour une image lue en texte). */
const text = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)

/** Ce que sert l'API : le contenu de l'image, ou le statut d'une réponse sans image. */
async function served(path: string) {
  const response = await app.request(`/v1${path}`)
  return response.status === 200 ? text(await response.arrayBuffer()) : response.status
}

describe('les chemins par langue', () => {
  test('un chemin français ne mène qu’à une image française', async () => {
    expect(cardScan('ja', 'SVP', 1, 'md')).toBe('/images/cards/SVP/1-md.webp')
    expect(cardScan('fr', 'SVP', 1, 'md')).toBe('/images/cards/fr/SVP/1-md.webp')
    expect(setLogo('ja', 'SVP', 'hd')).toBe('/images/sets/SVP-hd.webp')
    expect(setLogo('fr', 'SVP', 'hd')).toBe('/images/sets/fr/SVP-hd.webp')

    await put('/images/cards/SVP/1-md.webp', 'scan japonais')
    await put('/images/cards/fr/SVP/1-md.webp', 'scan français')
    await put('/images/sets/SVP-hd.webp', 'logo japonais')
    await put('/images/sets/fr/SVP-hd.webp', 'logo français')
    await put('/images/cards/fr/SVP/3-md.webp', 'troisième scan français')
    await put('/images/cards/SVP/3-md.webp', 'troisième scan, sans carte japonaise')

    // La série dans les deux langues : chaque chemin son image.
    await catalog('ja', 'fr')
    expect(await served('/images/cards/SVP/1-md.webp')).toBe('scan japonais')
    expect(await served('/images/cards/fr/SVP/1-md.webp')).toBe('scan français')
    expect(await served('/images/sets/SVP-hd.webp')).toBe('logo japonais')
    expect(await served('/images/sets/fr/SVP-hd.webp')).toBe('logo français')
    // Le rang plausible est celui de la langue : 3 cartes en français, 1 en japonais.
    expect(await served('/images/cards/fr/SVP/3-md.webp')).toBe('troisième scan français')
    expect(await served('/images/cards/SVP/3-md.webp')).toBe(404)

    // La série en japonais seulement : rien en français, même avec l'image.
    await catalog('ja')
    expect(await served('/images/cards/SVP/1-md.webp')).toBe('scan japonais')
    expect(await served('/images/sets/SVP-hd.webp')).toBe('logo japonais')
    expect(await served('/images/cards/fr/SVP/1-md.webp')).toBe(404)
    expect(await served('/images/sets/fr/SVP-hd.webp')).toBe(404)

    // La série en français seulement : rien en japonais.
    await catalog('fr')
    expect(await served('/images/cards/fr/SVP/1-md.webp')).toBe('scan français')
    expect(await served('/images/sets/fr/SVP-hd.webp')).toBe('logo français')
    expect(await served('/images/cards/SVP/1-md.webp')).toBe(404)
    expect(await served('/images/sets/SVP-hd.webp')).toBe(404)

    // L'icône d'une rareté est commune aux deux langues : celle d'un id que l'une connaît.
    await put('/images/rarities/33.webp', 'icône')
    expect(await served('/images/rarities/33.webp')).toBe(404)
    await env.DB.prepare(
      "INSERT INTO rarities (lang, id, name, rank) VALUES ('fr', 33, 'Double Rare', 1)",
    ).run()
    expect(await served('/images/rarities/33.webp')).toBe('icône')
  })

  test('une image absente répond 404 sans rien télécharger', async () => {
    await catalog('ja', 'fr')
    await env.DB.prepare(
      "INSERT INTO rarities (lang, id, name, rank) VALUES ('fr', 34, 'Ultra Rare', 2)",
    ).run()
    const network = vi.spyOn(globalThis, 'fetch')
    try {
      for (const path of [
        '/images/cards/SVP/1-hd.webp',
        '/images/cards/fr/SVP/2-hd.webp',
        '/images/sets/SVP-md.webp',
        '/images/sets/fr/SVP-md.webp',
        '/images/rarities/34.webp',
        '/images/types/1.webp',
        '/images/species/25.png',
        '/images/species/artwork/25.png',
      ]) {
        expect([path, await served(path)]).toEqual([path, 404])
      }
      expect(network).not.toHaveBeenCalled()
    } finally {
      network.mockRestore()
    }
  })

  test('servie avec son type et gardée un an', async () => {
    await put('/images/species/25.png', 'sprite')
    const response = await app.request('/v1/images/species/25.png')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})

describe('la copie des images (tâche `images`)', () => {
  /** `fetch` remplacé : un essai ne touche jamais le réseau. */
  let network: MockInstance<typeof fetch>

  // Aucune image, aucun catalogue d'un test à l'autre.
  beforeEach(async () => {
    await catalog()
    for (
      let listed = await env.FILES.list();
      listed.objects.length;
      listed = await env.FILES.list()
    ) {
      await env.FILES.delete(listed.objects.map(({ key }) => key))
    }
    network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Pas de réseau dans les tests'))
  })
  afterEach(() => network.mockRestore())

  /** Ce que la tâche a copié à ce chemin : le contenu de l'image, ou 404 sans image. */
  async function copied(path: string) {
    const object = await env.FILES.get(path.slice(1))
    return object ? text(await object.arrayBuffer()) : 404
  }

  describe('une série renumérotée par la source', () => {
    // Les chemins des scans suivent le rang : après l'arrivée d'une carte en tête de série, le
    // fichier du rang 1 est celui de l'ancienne première carte, qu'il ne faut jamais garder.
    const READ_AT = '2026-10-20T10:00:00.000Z'
    const LATER = '2026-10-21T10:00:00.000Z'

    /**
     * La série X chez la source : ses cartes, dans son ordre (leur rang : 1, 2…), et les tailles de
     * leur scan qu'elle a (toutes, sans précision).
     */
    type SourceCard = [id: number, name: string, sizes?: ('md' | 'hd')[]]
    let source: SourceCard[] = []

    /** La page de la série X telle que la source la donne à ce moment. */
    const seriesPage = (): PokecardexSeries => ({
      currentSeries: { shortName: 'X', fullName: 'Série X', releaseDateFR: '2026-10-01 00:00:00' },
      cartes: source.map(([id_card, name], index) => ({
        id_card,
        sort: index + 1,
        num_card: `${index + 1}/100`,
        name_card_fr: name,
        name_card_en: name,
        name_card_de: name,
        id_pokedex_list: [],
        id_cardmarket: null,
        cardmarket_url: null,
        only_english: 0,
        id_rarete: null,
        id_type: null,
        nom_illustrateur: '',
        versions: [],
      })),
    })

    /** La source change : ses cartes, et la lecture de la série par le catalogue. */
    const sourceHas = async (cards: SourceCard[], readAt: string) => {
      source = cards
      await saveSeries('ja', 'X', seriesPage(), readAt, null)
    }

    /**
     * `fetch` remplacé par les sources : le scan de chaque rang de la série X (« scan de <carte> »,
     * sinon 404), après `meanwhile` (ce qui change chez la source pendant sa copie) ; une image
     * pour tout le reste (logo, icônes).
     */
    const sourceAnswers = (meanwhile = async () => {}) =>
      network.mockImplementation(async (input) => {
        const scan = /\/sets_jp\/X\/(\d+)\.jpg\?class=(md|hd)/.exec(String(input))
        if (!scan) return new Response('image', { headers: { 'Content-Type': 'image/png' } })
        await meanwhile()
        const card = source[Number(scan[1]) - 1]
        return card && (card[2] ?? ['md', 'hd']).includes(scan[2] as 'md' | 'hd')
          ? new Response(`scan de ${card[1]}`, { headers: { 'Content-Type': 'image/webp' } })
          : new Response(null, { status: 404 })
      })

    /** Les étapes de la tâche, sauf les Pokémon et les réponses du catalogue, hors de ces tests. */
    const step: Step = (name, run) =>
      /^(Pokémon|réponses)/.test(name)
        ? Promise.resolve({ after: null, failed: [], found: 0 } as never)
        : run()

    const scans = async (ranks: number) => {
      const files: (string | number)[] = []
      for (let rank = 1; rank <= ranks; rank++) {
        files.push(await copied(cardScan('ja', 'X', rank, 'md')))
        files.push(await copied(cardScan('ja', 'X', rank, 'hd')))
      }
      return files
    }

    const noted = async () =>
      (
        await env.DB.prepare(
          "SELECT id, sort, image FROM cards WHERE lang = 'ja' ORDER BY sort",
        ).all()
      ).results

    test('une carte arrivée en tête : chaque carte retrouve son scan, recopié par la tâche', async () => {
      sourceAnswers()
      await sourceHas(
        [
          [10, 'Pikachu'],
          [11, 'Raichu'],
        ],
        READ_AT,
      )
      await images(step)
      expect(await scans(2)).toEqual([
        'scan de Pikachu',
        'scan de Pikachu',
        'scan de Raichu',
        'scan de Raichu',
      ])

      // Pichu arrive en tête : Pikachu passe au rang 2, Raichu au 3 (le catalogue les remet à
      // chercher), Pichu prend le rang 1, dont le fichier est celui de Pikachu.
      await sourceHas(
        [
          [12, 'Pichu'],
          [10, 'Pikachu'],
          [11, 'Raichu'],
        ],
        LATER,
      )
      await images(step)
      expect(await scans(3)).toEqual([
        'scan de Pichu',
        'scan de Pichu',
        'scan de Pikachu',
        'scan de Pikachu',
        'scan de Raichu',
        'scan de Raichu',
      ])
      expect(await noted()).toEqual([
        { id: 12, sort: 1, image: 'pokecardex' },
        { id: 10, sort: 2, image: 'pokecardex' },
        { id: 11, sort: 3, image: 'pokecardex' },
      ])
    })

    /**
     * Pichu arrive en tête sans scan chez la source (`sizes` : seulement ces tailles) : le fichier
     * du rang 1, celui de Pikachu, n'est jamais servi pour lui ni gardé, même à la recherche de la
     * semaine suivante.
     */
    async function arrivedWithoutScan(sizes: ('md' | 'hd')[]) {
      sourceAnswers()
      await sourceHas([[10, 'Pikachu']], READ_AT)
      await images(step)
      await sourceHas(
        [
          [12, 'Pichu', sizes],
          [10, 'Pikachu'],
        ],
        LATER,
      )
      await images(step)
      const files = [404, 404, 'scan de Pikachu', 'scan de Pikachu']
      const notes = [
        { id: 12, sort: 1, image: 'none' },
        { id: 10, sort: 2, image: 'pokecardex' },
      ]
      expect(await scans(2)).toEqual(files)
      expect(await noted()).toEqual(notes)
      // La semaine suivante, la carte sans scan est cherchée de nouveau ; la source ne l'a toujours
      // pas.
      await env.DB.prepare(
        "UPDATE cards SET image_checked = '2026-01-01T00:00:00.000Z' WHERE image = 'none'",
      ).run()
      await images(step)
      expect(await scans(2)).toEqual(files)
      expect(await noted()).toEqual(notes)
    }

    test('une carte arrivée en tête sans scan chez la source : jamais celui de sa voisine', () =>
      arrivedWithoutScan([]))

    test('une carte arrivée en tête avec un seul de ses deux scans : jamais celui de sa voisine', () =>
      arrivedWithoutScan(['md']))

    test('une carte que le catalogue déplace pendant sa copie n’est pas notée à son ancien rang', async () => {
      await sourceHas([[10, 'Pikachu']], READ_AT)
      // Le catalogue relit la série pendant la copie du scan de Pikachu (rang 1) : Pichu arrive en
      // tête, Pikachu passe au rang 2.
      let moved = false
      sourceAnswers(async () => {
        if (moved) return
        moved = true
        await sourceHas(
          [
            [12, 'Pichu'],
            [10, 'Pikachu'],
          ],
          LATER,
        )
      })
      await images(step)
      // Le rang 1 copié est celui de Pichu, cherché à sa place ; Pikachu, au rang 2, reste à
      // chercher.
      expect(await noted()).toEqual([
        { id: 12, sort: 1, image: 'pokecardex' },
        { id: 10, sort: 2, image: null },
      ])

      await images(step)
      expect(await scans(2)).toEqual([
        'scan de Pichu',
        'scan de Pichu',
        'scan de Pikachu',
        'scan de Pikachu',
      ])
      expect(await noted()).toEqual([
        { id: 12, sort: 1, image: 'pokecardex' },
        { id: 10, sort: 2, image: 'pokecardex' },
      ])
    })
  })

  test('l’adresse d’origine : le scan français est celui du dossier FR, jamais celui sans langue', async () => {
    const paths = [
      cardScan('ja', 'SVP', 1, 'md'),
      cardScan('fr', 'SVP', 1, 'hd'),
      setLogo('ja', 'SVP', 'md'),
      setLogo('fr', 'SVP', 'hd'),
    ]
    for (const path of paths) {
      network.mockResolvedValueOnce(
        new Response('image', { headers: { 'Content-Type': 'image/webp' } }),
      )
      expect(await mirror(path)).toBe(true)
      expect(await copied(path)).toBe('image')
    }
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([
      'https://pokecardex-scans.b-cdn.net/sets_jp/SVP/1.jpg?class=md',
      'https://pokecardex-scans.b-cdn.net/sets/SVP/FR/1.jpg?class=hd',
      'https://pokecardex.b-cdn.net/assets/images/logos_jp/SVP.png?class=md',
      'https://pokecardex.b-cdn.net/assets/images/logos/SVP.png?class=hd',
    ])
  })
})
