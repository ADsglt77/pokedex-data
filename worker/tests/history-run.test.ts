/**
 * Un passage de la tâche `history` (`worker/ingest/history.ts`) : une carte dont la page est en
 * échec n'est pas notée comme lue (`history_imports`), la tâche échoue pour le dire, et le passage
 * suivant la relit, elle seule ; la carte lue a ses prix dans l'historique. Notée avant d'être lue,
 * elle ne serait plus jamais reprise : son historique perdu, la source n'en garde que 180 jours.
 * Chaque carte, même en échec, redit le signe de vie de l'étape (`alive`) : sans lui, une étape de
 * 50 cartes (plus de 2 min) laisserait le passage tenu pour arrêté. Jamais le réseau : la page de
 * chaque carte est remplacée.
 */

import { expect, test, vi } from 'vitest'
import type { CardLanguage } from '@/contract'
import type { PokecardexCardPage } from '../ingest/pokecardex'
import type { Step } from '../ingest/workflow'
import { alive, rows, run } from './helpers'

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

/** La page d'une carte du produit `cardmarket` : son prix suivi, les 1er et 2 octobre. */
const pageOf = (cardmarket: number): PokecardexCardPage => ({
  carte: {
    cardmarketPrices: [{ id_cardmarket: String(cardmarket), id_version: null }],
    priceHistory: {
      cardmarket: {
        '180': {
          series: [{ id: 'main', versionId: null, variant: 'normale', metric: 'avg30' }],
          points: [
            { date: '2026-10-01', main: 2.5 },
            { date: '2026-10-02', main: 3 },
          ],
        },
      },
    },
  },
})

const imported = () => rows('SELECT lang, card FROM history_imports ORDER BY lang, card')
const prices = () => rows('SELECT id, year, first, prices FROM cardmarket_history ORDER BY id')

test('une carte en échec n’est pas notée comme lue : la tâche échoue, le passage suivant la relit, elle seule', async () => {
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
  await expect(history(step)).rejects.toThrow('1 carte en échec, relue au prochain passage')
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
