/**
 * Un passage de la tâche `catalog` (`worker/ingest/catalog.ts`) et ses gardes : dix pages en échec
 * d'affilée arrêtent la lecture, celle de l'autre langue comprise (le site a sans doute changé : on
 * ne le sollicite pas davantage) ; plus de la moitié des séries déjà connues rendues sans cartes
 * font échouer la tâche, leurs cartes gardées (le format des pages a changé, pas les séries) ; une
 * exclusivité d'autres pays d'Asie est écartée : pas lue une fois le menu connu (la première page
 * lue de la langue le donne), et celle qu'un passage d'avant a gardée est retirée. Jamais le
 * réseau : les lectures de Pokécardex sont remplacées.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { CardLanguage } from '@/contract'
import type { PokecardexCard, PokecardexSeries } from '../ingest/pokecardex'
import type { Step } from '../ingest/workflow'
import { emptyCatalog, rows, run } from './helpers'

// Les lectures de Pokécardex remplacées (ni réseau, ni 3 s par page) ; `catalog.ts`, déjà chargé
// par l'entrée du Worker, rechargé pour les prendre.
const source = vi.hoisted(() => ({
  readSitemap: vi.fn<() => Promise<string>>(),
  readSeries: vi.fn<(lang: CardLanguage, code: string) => Promise<PokecardexSeries>>(),
  readEnglishSeriesNames: vi.fn(async () => new Map<string, string>()),
}))
vi.mock(import('../ingest/pokecardex'), async (original) => ({ ...(await original()), ...source }))
vi.resetModules()
const { catalog } = await import('../ingest/catalog')

/** Les étapes de la tâche, sauf les réponses du catalogue (`saveLanguage`, testé à part). */
const step: Step = (name, work) =>
  name.startsWith('réponses') ? Promise.resolve(undefined as never) : work()

/** Le plan du site : ces séries japonaises, puis ces françaises. */
const sitemap = (japanese: string[], french: string[]) =>
  [
    ...japanese.map((code) => `<loc>/series/jp/${code}</loc>`),
    ...french.map((code) => `<loc>/series/${code}</loc>`),
  ].join('\n')

/**
 * La page d'une série : ses cartes (leurs ids ; le reste de leurs champs n'importe pas ici), et le
 * menu japonais, où CS1 est une exclusivité d'Asie.
 */
const page = (ids: number[]): PokecardexSeries => ({
  currentSeries: { fullName: 'Série', releaseDateFR: '2025-01-01 00:00:00' },
  cartes: ids.map((id) => ({ id_card: id, num_card: `${id}/9`, sort: id }) as PokecardexCard),
  seriesMenu: {
    blocksByRegion: {
      JP: [
        {
          name: 'Scarlet & Violet',
          nameUS: 'Scarlet & Violet',
          series: [
            { shortName: 'J1', fullName: 'Série 1' },
            { shortName: 'J2', fullName: 'Série 2' },
          ],
        },
        {
          name: 'Asia Exclusive',
          nameUS: 'Asia Exclusive',
          series: [{ shortName: 'CS1', fullName: 'Série chinoise' }],
        },
      ],
    },
  },
})

/** Chaque série lue rend la page de ces cartes. */
const pagesOf = (pages: Record<string, number[]>) =>
  source.readSeries.mockImplementation(async (_lang, code) => page(pages[code]!))

/** Le stockage partagé entre les tests du fichier : chacun part d'un catalogue vide. */
beforeEach(async () => {
  vi.resetAllMocks()
  await emptyCatalog()
})

describe('catalog', () => {
  test('dix pages en échec d’affilée arrêtent la lecture, sans aucune page française', async () => {
    const codes = Array.from({ length: 11 }, (_, index) => `J${index + 1}`)
    source.readSitemap.mockResolvedValue(sitemap(codes, ['MEG']))
    source.readSeries.mockRejectedValue(new Error('Pokécardex : pas de données'))
    await expect(catalog(step, false)).rejects.toThrow(
      '10 séries illisibles (J1, J2, J3, J4, J5, J6, J7, J8, J9, J10)',
    )
    expect(source.readSeries.mock.calls).toEqual(codes.slice(0, 10).map((code) => ['ja', code]))
    // Ni le nom anglais des séries françaises : une page de plus.
    expect(source.readEnglishSeriesNames).not.toHaveBeenCalled()
  })

  test('plus de la moitié des séries déjà connues rendues sans cartes : la tâche échoue, leurs cartes restent', async () => {
    source.readSitemap.mockResolvedValue(sitemap(['J1', 'J2', 'J3'], ['MEG']))
    pagesOf({ J1: [1], J2: [2], J3: [3], MEG: [4] })
    await catalog(step, false)
    // Deux sur quatre, la moitié tout juste : des séries vidées par la source, la tâche réussit.
    pagesOf({ J1: [], J2: [], J3: [3], MEG: [4] })
    await catalog(step, true)
    // Trois sur quatre : le champ des cartes renommé.
    pagesOf({ J1: [], J2: [], J3: [], MEG: [4] })
    await expect(catalog(step, true)).rejects.toThrow(
      'Séries déjà connues rendues sans cartes : 3 sur 4',
    )
    expect(await rows("SELECT lang, id, set_id AS 'set' FROM cards ORDER BY lang, id")).toEqual([
      { lang: 'fr', id: 4, set: 'MEG' },
      { lang: 'ja', id: 1, set: 'J1' },
      { lang: 'ja', id: 2, set: 'J2' },
      { lang: 'ja', id: 3, set: 'J3' },
    ])
  })

  test('une exclusivité d’Asie, le menu déjà lu, n’est pas lue ; celle qu’un passage d’avant a gardée est retirée', async () => {
    // CS1, gardée par un passage d'avant, lue il y a longtemps : à relire, si elle était japonaise.
    await run(
      `INSERT INTO sets (lang, id, name, released, read_at)
       VALUES ('ja', 'CS1', 'Série chinoise', '2025-01-01', '2026-01-01T10:00:00.000Z')`,
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       VALUES ('ja', 9, 'CS1', '1', 1, 'Carte', 0, '2026-01-01T10:00:00.000Z')`,
    )
    source.readSitemap.mockResolvedValue(sitemap(['J1', 'CS1', 'J2'], ['MEG']))
    pagesOf({ J1: [1], J2: [2], MEG: [3] })
    await catalog(step, false)
    expect(source.readSeries.mock.calls).toEqual([
      ['ja', 'J1'],
      ['ja', 'J2'],
      ['fr', 'MEG'],
    ])
    expect(await rows('SELECT lang, id FROM sets ORDER BY lang, id')).toEqual([
      { lang: 'fr', id: 'MEG' },
      { lang: 'ja', id: 'J1' },
      { lang: 'ja', id: 'J2' },
    ])
    expect(await rows("SELECT id FROM cards WHERE set_id = 'CS1'")).toEqual([])
  })
})
