/**
 * Les prix, que lisent la liste d'achats et le plan du site : l'API ne rend que ceux des cartes
 * demandées (`/v1/prices`), une clé pour chacune (`null` sans
 * prix : aucun prix n'est inventé, jamais celui d'une autre carte), avec un ETag qui change avec
 * eux. L'écriture quotidienne du guide des prix, et de l'historique (irremplaçable : Cardmarket
 * n'en garde pas) ; la série « récente » d'une carte (sa tendance) se juge dans sa langue ; une
 * liste des produits illisible, tronquée ou impossible à enregistrer n'arrête jamais les prix du
 * jour, et ne remplace pas celle d'avant.
 */

import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import type { PriceFile } from '@/contract'
import { readSource, writeSource } from '../src/db'
import { historyReader, historyStore } from '../src/history'
import { savePriceGuide, type PriceGuide, type ProductList } from '../src/jobs/prices'
import { referenceRoutes } from '../src/reference'
import { testData } from './server'

/** La base des prix : chaque test pose son propre état (ils passent dans n'importe quel ordre). */
const data = testData()

/** Aucun prix lu, aucun historique, aucun produit. */
function reset() {
  data.run("DELETE FROM sources WHERE name = 'cardmarket'")
  data.run('DELETE FROM cardmarket_prices')
  data.run('DELETE FROM cardmarket_history')
  data.run('DELETE FROM cardmarket_products')
}

/** Les prix du jour de trois cartes, et le passage de la tâche (`stamp`). */
function writePrices(stamp = 'lundi', date = '2026-10-12') {
  const write = data.query(
    'INSERT INTO cardmarket_prices (id, price, low, month_ago) VALUES (?, ?, ?, ?)',
  )
  write.run(719445, 6.87, 5, 7.2)
  write.run(719446, 99, null, null)
  write.run(719447, 1.5, 1, 2)
  writeSource(data, 'cardmarket', { stamp, date })
}

describe('/v1/prices', () => {
  const api = new Elysia().group('/v1', (group) => group.use(referenceRoutes(data)))
  const get = (path: string, headers: Record<string, string> = {}) =>
    api.handle(new Request(`http://localhost/v1/prices${path}`, { headers }))

  test('tant que les prix n’ont jamais été lus : 404', async () => {
    reset()
    expect((await get('?ids=719445')).status).toBe(404)
  })

  test('les prix des seules cartes demandées, une clé chacune (`null` sans prix), jamais ceux d’une autre', async () => {
    reset()
    writePrices()
    const response = await get('?ids=719446,1,719445,719445')
    expect(response.status).toBe(200)
    expect((await response.json()) as PriceFile).toEqual({
      date: '2026-10-12',
      cards: { '719445': [6.87, 5, 7.2], '719446': [99, null, null], '1': null },
    })
  })

  test('un ETag : 304 tant que les prix n’ont pas changé, puis les nouveaux', async () => {
    reset()
    writePrices()
    const first = await get('?ids=719445')
    const etag = first.headers.get('etag')!
    expect((await get('?ids=719445', { 'If-None-Match': etag })).status).toBe(304)
    // Affaibli par le nginx du site, qui compresse la réponse : le même.
    expect((await get('?ids=719445', { 'If-None-Match': `W/${etag}` })).status).toBe(304)
    // D'autres cartes : une autre réponse.
    expect((await get('?ids=719446', { 'If-None-Match': etag })).status).toBe(200)
    // Le passage suivant de la tâche : de nouveaux prix, un autre ETag.
    data.query('UPDATE cardmarket_prices SET price = 7.1 WHERE id = 719445').run()
    writeSource(data, 'cardmarket', { stamp: 'mardi', date: '2026-10-13' })
    const next = await get('?ids=719445', { 'If-None-Match': etag })
    expect(next.status).toBe(200)
    expect(((await next.json()) as PriceFile).cards['719445']![0]).toBe(7.1)
  })

  test('des ids mal écrits : refusés', async () => {
    expect((await get('?ids=719445,abc')).status).toBe(422)
    expect((await get('?ids=0719445')).status).toBe(422)
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
  const history = historyReader(data)
  const priceRow = (id: number) =>
    data
      .query('SELECT price, low, month_ago AS monthAgo FROM cardmarket_prices WHERE id = ?')
      .get(id)

  test('le jour suivant : ajouté à l’année de chaque carte, les autres cartes intactes', () => {
    reset()
    savePriceGuide(
      data,
      guide('2026-10-12', [
        [1, { trend: 9, avg30: 6.87, low: 5 }],
        [2, { avg30: 3 }],
      ]),
      products([1, 2]),
      'a',
    )
    savePriceGuide(
      data,
      guide('2026-10-13', [
        [1, { trend: 9, avg30: 7.1 }],
        [2, { avg30: 3 }],
      ]),
      products([1, 2]),
      'b',
    )
    expect(history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [6.87, 7.1] })
    expect(history(2)).toEqual({ name: 'Carte 2', from: '2026-10-12', prices: [3, 3] })
    expect(priceRow(1)).toEqual({ price: 7.1, low: null, monthAgo: null })
    expect(readSource(data, 'cardmarket')).toEqual({ stamp: 'b', date: '2026-10-13' })
  })

  test('relancée le même jour : le prix du jour remplacé, rien d’ajouté', () => {
    reset()
    savePriceGuide(data, guide('2026-10-12', [[1, { avg30: 6.87 }]]), products([1]), 'a')
    savePriceGuide(data, guide('2026-10-12', [[1, { avg30: 6.5 }]]), products([1]), 'a2')
    expect(history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [6.5] })
  })

  test('la règle de Pokécardex : moyenne sur 30 jours, à défaut 7 puis 1 jour ; la tendance pour une série récente', () => {
    reset()
    // Une série sortie 11 jours avant le guide, et sa carte : la tendance ; ensuite, la moyenne.
    data.run(
      "INSERT INTO sets (lang, id, name, released, read_at) VALUES ('ja', 'ESSAI-RECENT', 'Récente', '2026-10-01', '2026-10-01')",
    )
    data.run(
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       VALUES ('ja', 990001, 'ESSAI-RECENT', '1', 1, 'Récente', 5, '2026-10-01')`,
    )
    try {
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
      savePriceGuide(data, day, products([1, 2, 3, 4, 5]), 'a')
      expect(priceRow(1)).toEqual({ price: 4.2, low: null, monthAgo: null })
      expect(priceRow(2)).toMatchObject({ price: 5 })
      expect(priceRow(3)).toMatchObject({ price: 6 })
      // Une série ancienne sans moyenne : pas de prix, jamais la tendance à sa place.
      expect(priceRow(4)).toBeNull()
      expect(history(4)).toBeNull()
      expect(priceRow(5)).toMatchObject({ price: 9 })
      // Le scellé n'est pas une carte.
      expect(priceRow(9)).toBeNull()
      // 31 jours après sa sortie, la série n'est plus récente : la moyenne.
      const later = guide('2026-11-01', [
        [1, { avg30: 4.2 }],
        [2, { avg7: 5 }],
        [3, { avg1: 6 }],
        [5, { trend: 9, avg30: 4.2 }],
      ])
      savePriceGuide(data, later, products([1, 2, 3, 5]), 'b')
      expect(priceRow(5)).toMatchObject({ price: 4.2 })
    } finally {
      data.run('DELETE FROM cards WHERE id = 990001')
      data.run("DELETE FROM sets WHERE id = 'ESSAI-RECENT'")
    }
  })

  test('une série récente se juge dans la langue de la carte : le même code dans l’autre langue n’y change rien', () => {
    reset()
    // Le même code, récent au Japon, ancien en France : la carte française n'a pas la tendance.
    data.run(
      `INSERT INTO sets (lang, id, name, released, read_at) VALUES
         ('ja', 'ESSAI-LANGUE', 'Récente', '2026-10-01', '2026-10-01'),
         ('fr', 'ESSAI-LANGUE', 'Ancienne', '2020-01-01', '2026-10-01')`,
    )
    data.run(
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       VALUES ('fr', 990002, 'ESSAI-LANGUE', '1', 1, 'Ancienne', 5, '2026-10-01')`,
    )
    try {
      savePriceGuide(data, guide('2026-10-12', [[5, { trend: 9, avg30: 4.2 }]]), products([5]), 'a')
      expect(priceRow(5)).toMatchObject({ price: 4.2 })
    } finally {
      data.run('DELETE FROM cards WHERE id = 990002')
      data.run("DELETE FROM sets WHERE id = 'ESSAI-LANGUE'")
    }
  })

  test('le prix d’il y a 30 jours, d’après l’historique (ce jour-là sans prix : la semaine avant)', () => {
    reset()
    const store = historyStore(data)
    // Le 12 septembre (jour 254), 30 jours avant le 12 octobre ; le 10, 32 jours avant.
    store.save(1, { year: 2026, first: 254, prices: [5] })
    store.save(2, { year: 2026, first: 252, prices: [4, null, null] })
    store.save(3, { year: 2026, first: 240, prices: [3] })
    savePriceGuide(
      data,
      guide('2026-10-12', [
        [1, { avg30: 6 }],
        [2, { avg30: 6 }],
        [3, { avg30: 6 }],
      ]),
      products([1, 2, 3]),
      'a',
    )
    expect(priceRow(1)).toMatchObject({ price: 6, monthAgo: 5 })
    expect(priceRow(2)).toMatchObject({ monthAgo: 4 })
    // Plus d'une semaine plus tôt : rien.
    expect(priceRow(3)).toMatchObject({ monthAgo: null })
  })

  test('moins de la moitié des prix d’avant (le format a changé) : une erreur, rien d’écrit', () => {
    reset()
    savePriceGuide(
      data,
      guide('2026-10-12', [
        [1, { avg30: 1 }],
        [2, { avg30: 2 }],
        [3, { avg30: 3 }],
      ]),
      products([1, 2, 3]),
      'a',
    )
    expect(() =>
      savePriceGuide(data, guide('2026-10-13', [[1, { avg30: 1.5 }]]), products([1, 2, 3]), 'b'),
    ).toThrow('format changé')
    expect(history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [1] })
    expect(priceRow(2)).toEqual({ price: 2, low: null, monthAgo: null })
    expect(readSource(data, 'cardmarket')).toEqual({ stamp: 'a', date: '2026-10-12' })
  })

  describe('la liste des produits, sans laquelle les prix du jour s’enregistrent quand même', () => {
    const day = (date: string) =>
      guide(date, [
        [1, { avg30: 1 }],
        [2, { avg30: 2 }],
        [3, { avg30: 3 }],
      ])
    const product = (id: number) =>
      data.query('SELECT name, expansion, metacard FROM cardmarket_products WHERE id = ?').get(id)

    test('illisible (téléchargement en échec, format changé) : celle d’avant reste', () => {
      reset()
      savePriceGuide(data, day('2026-10-12'), products([1, 2, 3]), 'a')
      expect(savePriceGuide(data, day('2026-10-13'), null, 'b').unsavedProducts).toBe('illisible')
      expect(history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [1, 1] })
      expect(readSource(data, 'cardmarket')).toEqual({ stamp: 'b', date: '2026-10-13' })
      expect(product(3)).toEqual({ name: 'Carte 3', expansion: 7, metacard: 3 })
    })

    test('moins de la moitié des produits qu’elle donnait (tronquée) : celle d’avant reste', () => {
      reset()
      savePriceGuide(data, day('2026-10-12'), products([1, 2, 3]), 'a')
      const saved = savePriceGuide(data, day('2026-10-13'), products([1]), 'b')
      expect(saved.unsavedProducts).toBe('1 produit, contre 3')
      expect(history(3)).toEqual({ name: 'Carte 3', from: '2026-10-12', prices: [3, 3] })
      expect(product(2)).toEqual({ name: 'Carte 2', expansion: 7, metacard: 2 })
    })

    test('un produit qui ne s’enregistre pas (un champ renommé) : la liste entière est écartée', () => {
      reset()
      savePriceGuide(data, day('2026-10-12'), products([1, 2, 3]), 'a')
      const renamed = products([1, 2, 3])
      // `name` renommé chez Cardmarket : absent, il ne passerait pas `NOT NULL`.
      delete (renamed.products[2] as Partial<ProductList['products'][number]>).name
      renamed.products[0]!.name = 'Carte 1 renommée'
      const saved = savePriceGuide(data, day('2026-10-13'), renamed, 'b')
      expect(saved.unsavedProducts).toContain('NOT NULL')
      expect(history(1)).toEqual({ name: 'Carte 1', from: '2026-10-12', prices: [1, 1] })
      expect(product(1)).toEqual({ name: 'Carte 1', expansion: 7, metacard: 1 })
    })
  })

  test('un produit que la liste ne donne plus : son nom reste, son extension part', () => {
    reset()
    const day = (date: string) =>
      guide(date, [
        [1, { avg30: 1 }],
        [2, { avg30: 2 }],
      ])
    savePriceGuide(data, day('2026-10-12'), products([1, 2]), 'a')
    savePriceGuide(data, day('2026-10-13'), products([1]), 'b')
    expect(
      data.query('SELECT name, expansion, metacard FROM cardmarket_products WHERE id = 2').get(),
    ).toEqual({ name: 'Carte 2', expansion: null, metacard: null })
  })
})
