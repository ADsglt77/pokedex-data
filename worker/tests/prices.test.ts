/**
 * Les prix, que lisent la liste d'achats et le plan du site : l'API ne rend que ceux des cartes
 * demandées (`/v1/prices`), une clé pour chacune (`null` sans prix : aucun prix n'est inventé,
 * jamais celui d'une autre carte), avec un ETag qui change avec eux. Et l'historique de chaque
 * carte (`/v1/prices/:id`, `/v1/histories`) : ses années dans l'ordre, mises bout à bout, avec son
 * nom ; jamais celui d'une autre carte. Puis leur écriture quotidienne par la tâche `prices`, et
 * celle de l'historique (irremplaçable : Cardmarket n'en garde pas) ; la série « récente » d'une
 * carte (sa tendance) se juge dans sa langue ; une liste des produits illisible, tronquée ou
 * impossible à enregistrer n'arrête jamais les prix du jour, et ne remplace pas celle d'avant ; un
 * passage arrêté en route ne laisse rien de ses prix. Le guide et la liste, lus en flux.
 */

import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import type { PriceFile, PriceHistories } from '@/contract'
import { app } from '../app'
import { readHistories } from '../history'
import { streamArray } from '../ingest/json-stream'
import { savePriceGuide, type PriceGuide, type ProductList } from '../ingest/prices'
import { readSource, writeSource } from '../ingest/sources'

/** Aucun prix lu, aucun historique, aucun produit. */
const reset = () =>
  env.DB.batch(
    [
      "DELETE FROM sources WHERE name = 'cardmarket'",
      'DELETE FROM cardmarket_prices',
      'DELETE FROM cardmarket_history',
      'DELETE FROM cardmarket_products',
    ].map((sql) => env.DB.prepare(sql)),
  )

/** Le passage de la tâche `prices` (`stamp`) et le jour de son guide. */
const priceSource = (stamp: string, date: string) =>
  writeSource('cardmarket', { stamp, date }).run()

/** Les prix du jour de trois cartes, et le passage de la tâche. */
async function writePrices() {
  const write = env.DB.prepare(
    'INSERT INTO cardmarket_prices (id, price, low, month_ago) VALUES (?, ?, ?, ?)',
  )
  await env.DB.batch([
    write.bind(719445, 6.87, 5, 7.2),
    write.bind(719446, 99, null, null),
    write.bind(719447, 1.5, 1, 2),
  ])
  await priceSource('lundi', '2026-10-12')
}

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`/v1${path}`, { headers })

describe('/v1/prices', () => {
  test('tant que les prix n’ont jamais été lus : 404', async () => {
    await reset()
    expect((await get('/prices?ids=719445')).status).toBe(404)
  })

  test('les prix des seules cartes demandées, une clé chacune (`null` sans prix), jamais ceux d’une autre', async () => {
    await reset()
    await writePrices()
    const response = await get('/prices?ids=719446,1,719445,719445')
    expect(response.status).toBe(200)
    expect((await response.json()) as PriceFile).toEqual({
      date: '2026-10-12',
      cards: { '719445': [6.87, 5, 7.2], '719446': [99, null, null], '1': null },
    })
  })

  test('un ETag : 304 tant que les prix n’ont pas changé, puis les nouveaux', async () => {
    await reset()
    await writePrices()
    const first = await get('/prices?ids=719445')
    const etag = first.headers.get('etag')!
    expect((await get('/prices?ids=719445', { 'If-None-Match': etag })).status).toBe(304)
    // Affaibli par un relais qui compresse la réponse : le même.
    expect((await get('/prices?ids=719445', { 'If-None-Match': `W/${etag}` })).status).toBe(304)
    // D'autres cartes : une autre réponse.
    expect((await get('/prices?ids=719446', { 'If-None-Match': etag })).status).toBe(200)
    // Le passage suivant de la tâche : de nouveaux prix, un autre ETag.
    await env.DB.prepare('UPDATE cardmarket_prices SET price = 7.1 WHERE id = 719445').run()
    await priceSource('mardi', '2026-10-13')
    const next = await get('/prices?ids=719445', { 'If-None-Match': etag })
    expect(next.status).toBe(200)
    expect(((await next.json()) as PriceFile).cards['719445']![0]).toBe(7.1)
  })

  test('des ids mal écrits : refusés', async () => {
    expect((await get('/prices?ids=719445,abc')).status).toBe(422)
    expect((await get('/prices?ids=0719445')).status).toBe(422)
    expect((await get('/histories?ids=')).status).toBe(422)
  })
})

describe('l’historique de chaque carte', () => {
  /** Deux années pour Charmander, une pour la carte 719446 (hors de la liste des produits). */
  async function seed() {
    await reset()
    await priceSource('lundi', '2026-10-12')
    const year = env.DB.prepare('INSERT INTO cardmarket_history VALUES (?, ?, ?, ?)')
    await env.DB.batch([
      year.bind(719621, 2026, 0, '[2,3]'),
      year.bind(719621, 2025, 363, '[1]'),
      year.bind(719446, 2026, 286, '[7]'),
      env.DB.prepare(
        "INSERT INTO cardmarket_products (id, name) VALUES (719621, 'Charmander [Blazing Destruction]')",
      ),
    ])
  }

  test('chaque carte son historique, ses années dans l’ordre, avec son nom', async () => {
    await seed()
    const charmander = {
      name: 'Charmander [Blazing Destruction]',
      from: '2025-12-30',
      prices: [1, null, 2, 3],
    }
    expect(await (await get('/prices/719621')).json()).toEqual(charmander)
    expect((await (await get('/histories?ids=719446,719621')).json()) as PriceHistories).toEqual({
      '719446': { name: null, from: '2026-10-14', prices: [7] },
      '719621': charmander,
    })
  })

  test('une carte sans historique : rien, jamais celui d’une autre', async () => {
    await seed()
    expect(await (await get('/histories?ids=1,719446')).json()).toEqual({
      '1': null,
      '719446': { name: null, from: '2026-10-14', prices: [7] },
    })
    expect((await get('/prices/1')).status).toBe(404)
  })
})

describe('savePriceGuide : les prix du jour et l’historique', () => {
  const SINGLE = 51
  type Values = Partial<Record<'trend' | 'avg1' | 'avg7' | 'avg30' | 'low', number | null>>
  /** Un guide des prix du jour `day` : une ligne par carte (`[id, ses prix]`). */
  const guide = (
    day: string,
    rows: [id: number, values: Values][],
    sealed: number[] = [],
  ): PriceGuide => ({
    createdAt: `${day}T03:00:00+0200`,
    priceGuides: [
      ...rows.map(([idProduct, values]) => ({
        idProduct,
        idCategory: SINGLE,
        trend: null,
        avg1: null,
        avg7: null,
        avg30: null,
        low: null,
        ...values,
      })),
      ...sealed.map((idProduct) => ({
        idProduct,
        idCategory: 52,
        trend: 50,
        avg1: 50,
        avg7: 50,
        avg30: 50,
        low: 40,
      })),
    ],
  })
  const products = (ids: number[]): ProductList => ({
    products: ids.map((idProduct) => ({
      idProduct,
      name: `Carte ${idProduct}`,
      idExpansion: 7,
      idMetacard: idProduct,
    })),
  })
  /** L'historique d'une carte, tel que le rend l'API, avec son nom. */
  const history = async (id: number) => (await readHistories([id]))[id]
  const priceRow = (id: number) =>
    env.DB.prepare('SELECT price, low, month_ago AS monthAgo FROM cardmarket_prices WHERE id = ?')
      .bind(id)
      .first()
  const run = (...sql: string[]) => env.DB.batch(sql.map((query) => env.DB.prepare(query)))

  test('le jour suivant : ajouté à l’année de chaque carte, les autres cartes intactes', async () => {
    await reset()
    await savePriceGuide(
      guide('2026-10-12', [
        [1, { trend: 9, avg30: 6.87, low: 5 }],
        [2, { avg30: 3 }],
      ]),
      products([1, 2]),
      'a',
    )
    expect(await priceRow(1)).toEqual({ price: 6.87, low: 5, monthAgo: null })
    await savePriceGuide(
      guide('2026-10-13', [
        [1, { trend: 9, avg30: 7.1 }],
        [2, { avg30: 3 }],
      ]),
      products([1, 2]),
      'b',
    )
    expect(await history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [6.87, 7.1] })
    expect(await history(2)).toEqual({ name: 'Carte 2', from: '2026-10-12', prices: [3, 3] })
    expect(await priceRow(1)).toEqual({ price: 7.1, low: null, monthAgo: null })
    expect(await readSource('cardmarket')).toEqual({ stamp: 'b', date: '2026-10-13' })
  })

  test('relancée le même jour : le prix du jour remplacé, rien d’ajouté', async () => {
    await reset()
    await savePriceGuide(guide('2026-10-12', [[1, { avg30: 6.87 }]]), products([1]), 'a')
    await savePriceGuide(guide('2026-10-12', [[1, { avg30: 6.5 }]]), products([1]), 'a2')
    expect(await history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [6.5] })
  })

  test('les prix d’un passage arrêté en route ne passent jamais dans ceux du suivant', async () => {
    await reset()
    // Mis de côté par un passage arrêté avant de remplacer les prix de la veille.
    await run(
      'DELETE FROM cardmarket_prices_next',
      'INSERT INTO cardmarket_prices_next (id, price, low, month_ago) VALUES (2, 50, null, null)',
    )
    await savePriceGuide(guide('2026-10-12', [[1, { avg30: 6.87 }]]), products([1, 2]), 'a')
    expect(await priceRow(1)).toEqual({ price: 6.87, low: null, monthAgo: null })
    expect(await priceRow(2)).toBeNull()
  })

  test('la règle de Pokécardex : moyenne sur 30 jours, à défaut 7 puis 1 jour ; la tendance pour une série récente', async () => {
    await reset()
    // Une série sortie 11 jours avant le guide, et sa carte : la tendance ; ensuite, la moyenne.
    await run(
      "INSERT INTO sets (lang, id, name, released, read_at) VALUES ('ja', 'ESSAI-RECENT', 'Récente', '2026-10-01', '2026-10-01')",
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       VALUES ('ja', 990001, 'ESSAI-RECENT', '1', 1, 'Récente', 5, '2026-10-01')`,
    )
    const day = guide(
      '2026-10-12',
      [
        [1, { trend: 9, avg30: 4.2, avg7: 5, avg1: 6, low: 0 }],
        [2, { trend: 9, avg7: 5, avg1: 6 }],
        [3, { trend: 9, avg1: 6 }],
        [4, { trend: 9 }],
        [5, { trend: 9, avg30: 4.2 }],
      ],
      [9],
    )
    await savePriceGuide(day, products([1, 2, 3, 4, 5]), 'a')
    expect(await priceRow(1)).toEqual({ price: 4.2, low: null, monthAgo: null })
    expect(await priceRow(2)).toMatchObject({ price: 5 })
    expect(await priceRow(3)).toMatchObject({ price: 6 })
    // Une série ancienne sans moyenne : pas de prix, jamais la tendance à sa place.
    expect(await priceRow(4)).toBeNull()
    expect(await history(4)).toBeNull()
    expect(await priceRow(5)).toMatchObject({ price: 9 })
    // Le scellé n'est pas une carte.
    expect(await priceRow(9)).toBeNull()
    // 31 jours après sa sortie, la série n'est plus récente : la moyenne.
    const later = guide('2026-11-01', [
      [1, { avg30: 4.2 }],
      [2, { avg7: 5 }],
      [3, { avg1: 6 }],
      [5, { trend: 9, avg30: 4.2 }],
    ])
    await savePriceGuide(later, products([1, 2, 3, 5]), 'b')
    expect(await priceRow(5)).toMatchObject({ price: 4.2 })
    await run('DELETE FROM cards WHERE id = 990001', "DELETE FROM sets WHERE id = 'ESSAI-RECENT'")
  })

  test('une série récente se juge dans la langue de la carte : le même code dans l’autre langue n’y change rien', async () => {
    await reset()
    // Le même code, récent au Japon, ancien en France : la carte française n'a pas la tendance.
    await run(
      `INSERT INTO sets (lang, id, name, released, read_at) VALUES
         ('ja', 'ESSAI-LANGUE', 'Récente', '2026-10-01', '2026-10-01'),
         ('fr', 'ESSAI-LANGUE', 'Ancienne', '2020-01-01', '2026-10-01')`,
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       VALUES ('fr', 990002, 'ESSAI-LANGUE', '1', 1, 'Ancienne', 5, '2026-10-01')`,
    )
    await savePriceGuide(guide('2026-10-12', [[5, { trend: 9, avg30: 4.2 }]]), products([5]), 'a')
    expect(await priceRow(5)).toMatchObject({ price: 4.2 })
    await run('DELETE FROM cards WHERE id = 990002', "DELETE FROM sets WHERE id = 'ESSAI-LANGUE'")
  })

  test('le prix d’il y a 30 jours, d’après l’historique (ce jour-là sans prix : la semaine avant)', async () => {
    await reset()
    // Le 12 septembre (jour 254), 30 jours avant le 12 octobre ; le 10, 32 jours avant.
    await run(
      "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (1, 2026, 254, '[5]')",
      "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (2, 2026, 252, '[4,null,null]')",
      "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (3, 2026, 240, '[3]')",
    )
    await savePriceGuide(
      guide('2026-10-12', [
        [1, { avg30: 6 }],
        [2, { avg30: 6 }],
        [3, { avg30: 6 }],
      ]),
      products([1, 2, 3]),
      'a',
    )
    expect(await priceRow(1)).toMatchObject({ price: 6, monthAgo: 5 })
    expect(await priceRow(2)).toMatchObject({ monthAgo: 4 })
    // Plus d'une semaine plus tôt : rien.
    expect(await priceRow(3)).toMatchObject({ monthAgo: null })
  })

  test('moins de la moitié des prix d’avant (le format a changé) : une erreur, rien d’écrit', async () => {
    await reset()
    await savePriceGuide(
      guide('2026-10-12', [
        [1, { avg30: 1 }],
        [2, { avg30: 2 }],
        [3, { avg30: 3 }],
      ]),
      products([1, 2, 3]),
      'a',
    )
    await expect(
      savePriceGuide(guide('2026-10-13', [[1, { avg30: 1.5 }]]), products([1, 2, 3]), 'b'),
    ).rejects.toThrow('format changé')
    expect(await history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [1] })
    expect(await priceRow(2)).toEqual({ price: 2, low: null, monthAgo: null })
    expect(await readSource('cardmarket')).toEqual({ stamp: 'a', date: '2026-10-12' })
  })

  describe('la liste des produits, sans laquelle les prix du jour s’enregistrent quand même', () => {
    const day = (date: string) =>
      guide(date, [
        [1, { avg30: 1 }],
        [2, { avg30: 2 }],
        [3, { avg30: 3 }],
      ])
    const product = (id: number) =>
      env.DB.prepare('SELECT name, expansion, metacard FROM cardmarket_products WHERE id = ?')
        .bind(id)
        .first()

    test('illisible (téléchargement en échec, format changé) : celle d’avant reste', async () => {
      await reset()
      await savePriceGuide(day('2026-10-12'), products([1, 2, 3]), 'a')
      const saved = await savePriceGuide(day('2026-10-13'), null, 'b')
      expect(saved.unsavedProducts).toBe('illisible')
      expect(await history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [1, 1] })
      expect(await readSource('cardmarket')).toEqual({ stamp: 'b', date: '2026-10-13' })
      expect(await product(3)).toEqual({ name: 'Carte 3', expansion: 7, metacard: 3 })
    })

    test('moins de la moitié des produits qu’elle donnait (tronquée) : celle d’avant reste', async () => {
      await reset()
      await savePriceGuide(day('2026-10-12'), products([1, 2, 3]), 'a')
      const saved = await savePriceGuide(day('2026-10-13'), products([1]), 'b')
      expect(saved.unsavedProducts).toBe('1 produit, contre 3')
      expect(await history(3)).toEqual({ name: 'Carte 3', from: '2026-10-12', prices: [3, 3] })
      expect(await product(2)).toEqual({ name: 'Carte 2', expansion: 7, metacard: 2 })
    })

    test('un produit qui ne s’enregistre pas (un champ renommé) : la liste entière est écartée', async () => {
      await reset()
      await savePriceGuide(day('2026-10-12'), products([1, 2, 3]), 'a')
      const renamed = products([1, 2, 3])
      // `name` renommé chez Cardmarket : absent, il ne passerait pas `NOT NULL`.
      delete (renamed.products[2] as Partial<ProductList['products'][number]>).name
      renamed.products[0]!.name = 'Carte 1 renommée'
      const saved = await savePriceGuide(day('2026-10-13'), renamed, 'b')
      expect(saved.unsavedProducts).toContain('NOT NULL')
      expect(await history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [1, 1] })
      expect(await product(1)).toEqual({ name: 'Carte 1', expansion: 7, metacard: 1 })
    })
  })

  test('un produit que la liste ne donne plus : son nom reste, son extension part', async () => {
    await reset()
    const day = (date: string) =>
      guide(date, [
        [1, { avg30: 1 }],
        [2, { avg30: 2 }],
      ])
    await savePriceGuide(day('2026-10-12'), products([1, 2]), 'a')
    await savePriceGuide(day('2026-10-13'), products([1]), 'b')
    const kept = await env.DB.prepare(
      'SELECT name, expansion, metacard FROM cardmarket_products WHERE id = 2',
    ).first()
    expect(kept).toEqual({ name: 'Carte 2', expansion: null, metacard: null })
  })
})

describe('streamArray : le guide des prix et la liste des produits, lus en flux', () => {
  const text =
    '{"version":1,"createdAt":"2026-10-12T03:00:00+0200","priceGuides":[' +
    '{"idProduct":1,"name":"Pokémon } \\" { ]"},{"idProduct":2,"more":{"list":[1,2]}}' +
    '],"end":"]"}'
  const bytes = new TextEncoder().encode(text)
  const read = async (chunks: Uint8Array[]) => {
    const items: unknown[] = []
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk))
        controller.close()
      },
    })
    const rest = await streamArray(body, 'priceGuides', (item) => items.push(item))
    return { items, rest }
  }
  const expected = {
    items: (JSON.parse(text) as PriceGuide).priceGuides,
    rest: '{"version":1,"createdAt":"2026-10-12T03:00:00+0200",,"end":"]"}',
  }

  test('chaque objet du tableau, et le reste du document, où que tombent les coupures', async () => {
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(await read([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(expected)
    }
    expect(await read([...bytes].map((byte) => new Uint8Array([byte])))).toEqual(expected)
  })
})
