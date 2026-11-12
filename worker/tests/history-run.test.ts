/**
 * Un passage de la tâche `history` (`worker/ingest/history.ts`) : une carte dont la page est en
 * échec n'est pas notée comme lue (`history_imports`), le passage réussit quand même (le bilan du
 * journal la compte, à surveiller), et le passage suivant la relit, elle seule ; la carte lue a ses
 * prix dans l'historique. Notée avant d'être lue, elle ne serait plus jamais reprise : son
 * historique perdu, la source n'en garde que 180 jours. Dix pages en échec d'affilée font échouer
 * le passage (le site a sans doute changé) ; des pages sans historique pour la plupart des cartes
 * dont le guide des prix donne un prix depuis un mois aussi (le format des pages a changé), ou dont
 * aucun jour n'est dans les bornes de la reprise (une date fausse), sans noter ces cartes. Chaque
 * carte, même en échec, redit le signe de vie de l'étape (`alive`) : sans lui, une étape de 50
 * cartes (plus de 2 min) laisserait le passage tenu pour arrêté. Jamais le réseau : la page de
 * chaque carte est remplacée.
 */

import { beforeEach, expect, test, vi } from 'vitest'
import type { CardLanguage } from '@/contract'
import type { PokecardexCardPage } from '../ingest/pokecardex'
import type { Step } from '../ingest/workflow'
import { alive, emptyCatalog, rows, run } from './helpers'

// La page d'une carte remplacée (ni réseau, ni 3 s par page) ; `history.ts`, déjà chargé par
// l'entrée du Worker, rechargé pour la prendre.
const readCard = vi.hoisted(() =>
  vi.fn<(lang: CardLanguage, id: number) => Promise<PokecardexCardPage>>(),
)
vi.mock(import('../ingest/pokecardex'), async (original) => ({ ...(await original()), readCard }))
vi.resetModules()
const { history } = await import('../ingest/history')

/** Le signe de vie des étapes, compté. */
const lifeSign = vi.fn(alive)
const step: Step = (_name, work) => work(lifeSign)

/**
 * La page d'une carte du produit `cardmarket` : son prix suivi, les 1er et 2 octobre ; `variant` :
 * le nom de la variante de la carte elle-même (« normale » ; un autre : le format a changé).
 */
const pageOf = (cardmarket: number, variant = 'normale'): PokecardexCardPage => ({
  carte: {
    cardmarketPrices: [{ id_cardmarket: String(cardmarket), id_version: null }],
    priceHistory: {
      cardmarket: {
        '180': {
          series: [{ id: 'main', versionId: null, variant, metric: 'avg30' }],
          points: [
            { date: '2026-10-01', main: 2.5 },
            { date: '2026-10-02', main: 3 },
          ],
        },
      },
    },
  },
})

/** La page d'une carte sans historique (sans vente, ou sortie depuis peu). */
const withoutHistory = (cardmarket: number): PokecardexCardPage => ({
  carte: { cardmarketPrices: [{ id_cardmarket: String(cardmarket), id_version: null }] },
})

/** Les ids de `from` à `to`. */
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** Des cartes japonaises de la série SVP : l'id `n`, le produit 4000 + n. */
const addCards = (cards: number[]) =>
  run(
    `INSERT OR IGNORE INTO sets (lang, id, name, released, read_at)
     VALUES ('ja', 'SVP', 'Promos', '2023-01-01', '2026-10-22')`,
    [
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       SELECT 'ja', value, 'SVP', value, value, 'Carte', 4000 + value, '2026-10-22'
       FROM json_each(?)`,
      JSON.stringify(cards),
    ],
  )

/** Le prix du jour du produit de ces cartes, et celui d'il y a 30 jours (`null` : aucun). */
const addPrices = (cards: number[], monthAgo: number | null) =>
  run([
    `INSERT INTO cardmarket_prices (id, price, low, month_ago)
     SELECT 4000 + value, 3, NULL, ? FROM json_each(?)`,
    monthAgo,
    JSON.stringify(cards),
  ])

const imported = () => rows('SELECT lang, card FROM history_imports ORDER BY lang, card')
const prices = () => rows('SELECT id, year, first, prices FROM cardmarket_history ORDER BY id')

// Chaque test pose ses cartes, leurs prix et leurs pages.
beforeEach(async () => {
  await run(
    'DELETE FROM history_imports',
    'DELETE FROM cardmarket_history',
    'DELETE FROM cardmarket_prices',
    'DELETE FROM sources',
  )
  await emptyCatalog()
  readCard.mockReset()
  lifeSign.mockClear()
})

test('une carte en échec n’est pas notée comme lue : le passage réussit, le bilan la compte, le suivant la relit, elle seule', async () => {
  // Deux cartes du catalogue : la japonaise 1 (produit 4001), la française 2 (produit 4002).
  await run(
    `INSERT INTO sets (lang, id, name, released, read_at)
     VALUES ('ja', 'SVP', 'Promos', '2023-01-01', '2026-10-22'),
            ('fr', 'SVP', 'Promos', '2023-01-01', '2026-10-22')`,
    `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
     VALUES ('ja', 1, 'SVP', '1', 1, 'Carte', 4001, '2026-10-22'),
            ('fr', 2, 'SVP', '1', 1, 'Carte', 4002, '2026-10-22')`,
  )
  readCard.mockImplementation(async (lang) => {
    if (lang === 'fr') throw new Error('Pokécardex : pas de données dans /carte/2')
    return pageOf(4001)
  })
  const log = vi.spyOn(console, 'log')
  await history(step)
  // Le bilan, à surveiller (▲) : la carte en échec comptée.
  expect(log).toHaveBeenCalledWith(
    expect.stringMatching(/▲\s+tâches\s+Historique repris\s+cartes=1 jours=2 enÉchec=1$/),
  )
  log.mockRestore()
  // Un signe de vie par carte, celle en échec comprise.
  expect(lifeSign).toHaveBeenCalledTimes(2)
  expect(await imported()).toEqual([{ lang: 'ja', card: 1 }])
  // Le 1er octobre : le jour 273.
  expect(await prices()).toEqual([{ id: 4001, year: 2026, first: 273, prices: '[2.5,3]' }])

  // Le passage suivant : la page de la française lisible ; elle seule est lue.
  readCard.mockClear().mockResolvedValue(pageOf(4002))
  lifeSign.mockClear()
  await history(step)
  expect(readCard.mock.calls).toEqual([['fr', 2]])
  expect(lifeSign).toHaveBeenCalledTimes(1)
  expect(await imported()).toEqual([
    { lang: 'fr', card: 2 },
    { lang: 'ja', card: 1 },
  ])
  expect(await prices()).toEqual([
    { id: 4001, year: 2026, first: 273, prices: '[2.5,3]' },
    { id: 4002, year: 2026, first: 273, prices: '[2.5,3]' },
  ])
})

test('dix pages en échec d’affilée : le passage échoue (le site a sans doute changé)', async () => {
  await addCards(ids(1, 10))
  readCard.mockRejectedValue(new Error('Pokécardex : clé de ses données introuvable'))
  await expect(history(step)).rejects.toThrow('10 pages en échec')
  expect(await imported()).toEqual([])
})

test('la plupart des cartes au prix suivi depuis un mois sans historique : le passage échoue (format changé ?), sans les noter', async () => {
  // Douze cartes avec un prix aujourd'hui, mais aucun il y a 30 jours (une série nouvelle) : sans
  // historique, onze sur douze, c'est normal ; toutes sont notées.
  await addCards(ids(101, 112))
  await addPrices(ids(101, 112), null)
  readCard.mockImplementation(async (_lang, id) =>
    id === 101 ? pageOf(4000 + id) : withoutHistory(4000 + id),
  )
  await history(step)
  expect(await imported()).toHaveLength(12)

  // Douze cartes avec un prix aujourd'hui et il y a 30 jours : Pokécardex a forcément leur
  // historique. Dix pages n'en donnent pas (la variante renommée) : le format a changé.
  await addCards(ids(201, 212))
  await addPrices(ids(201, 212), 2)
  readCard.mockImplementation(async (_lang, id) =>
    id <= 202 ? pageOf(4000 + id) : pageOf(4000 + id, 'normal'),
  )
  await expect(history(step)).rejects.toThrow(/10 pages sur 12 .* \(format des pages changé \?\)/)
  // Seules les deux lues avec leur historique sont notées.
  const read = () => rows('SELECT card FROM history_imports WHERE card > 200 ORDER BY card')
  expect(await read()).toEqual([{ card: 201 }, { card: 202 }])

  // Le format repris : le passage suivant relit les dix, elles seules.
  readCard.mockClear().mockImplementation(async (_lang, id) => pageOf(4000 + id))
  await history(step)
  expect(readCard.mock.calls.map(([, id]) => id)).toEqual(ids(203, 212))
  expect(await read()).toHaveLength(12)
})

test('des pages dont aucun jour n’est dans les bornes de la reprise (une date fausse) : comptées sans historique, le passage échoue sans les noter', async () => {
  // Le dernier relevé, plus de 200 jours après les jours des pages (1er et 2 octobre 2026).
  await run("INSERT INTO sources (name, stamp, date) VALUES ('cardmarket', 'x', '2027-06-01')")
  await addCards(ids(301, 312))
  await addPrices(ids(301, 312), 2)
  readCard.mockImplementation(async (_lang, id) => pageOf(4000 + id))
  await expect(history(step)).rejects.toThrow(/12 pages sur 12 .* \(format des pages changé \?\)/)
  expect(await imported()).toEqual([])
  expect(await prices()).toEqual([])
})
