/**
 * L'historique des prix : irremplaçable, Cardmarket n'en garde pas. La tâche `prices` y ajoute
 * chaque jour le prix du jour (`withPrice`) et lit celui d'il y a 30 jours (`priceBefore`), la
 * tâche `history` y reprend celui de Pokécardex des 180 derniers jours (`mainHistory`,
 * `mergeHistory` : jamais celui d'une autre version, jamais le relevé du jour remplacé), la base le
 * range par année, l'API le rend d'un seul tenant (`joinYears`) : aucun prix ne doit se perdre,
 * changer de jour en route, ni passer d'une carte à une autre. Les deux tâches peuvent écrire la
 * même année en même temps : chacune ne la réécrit que si l'autre n'y a pas touché entre-temps
 * (`writeYears`), sinon le prix du jour s'effacerait. Seuls des jours écrits AAAA-MM-JJ sont repris.
 * La reprise (`historyTodo`) suit la langue : l'id d'une carte japonaise lue ne fait pas sauter la
 * française au même id.
 */

import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { joinYears, priceBefore, withPrice, yearDay, type HistoryYear } from '@/lib/history'
import { historyTodo, mainHistory, mergeHistory } from '../ingest/history'
import type { PokecardexHistory } from '../ingest/pokecardex'
import { savePriceGuide, type PriceGuide } from '../ingest/prices'
import { readYears, writeYears } from '../ingest/years'

describe('jour de l’année', () => {
  test('le 1er janvier est le jour 0, les années bissextiles ont un jour de plus', () => {
    expect(yearDay('2026-01-01')).toEqual([2026, 0])
    expect(yearDay('2026-10-14')).toEqual([2026, 286])
    expect(yearDay('2025-12-31')).toEqual([2025, 364])
    expect(yearDay('2024-12-31')).toEqual([2024, 365])
  })
})

describe('prix du jour ajouté à une année', () => {
  const known: HistoryYear = { year: 2026, first: 10, prices: [5, 6] }

  test('le même prix le même jour : rien à réécrire', () => {
    expect(withPrice(known, 2026, 11, 6)).toBe(known)
  })

  test('relancée le même jour, la tâche remplace le prix du jour', () => {
    expect(withPrice(known, 2026, 11, 7)).toEqual({ year: 2026, first: 10, prices: [5, 7] })
  })

  test('des jours sans prix entre deux relevés restent vides', () => {
    expect(withPrice(known, 2026, 14, 8)).toEqual({
      year: 2026,
      first: 10,
      prices: [5, 6, null, null, 8],
    })
  })

  test('un prix avant le premier jour connu le devance, sans décaler les autres', () => {
    expect(withPrice(known, 2026, 8, 4)).toEqual({ year: 2026, first: 8, prices: [4, null, 5, 6] })
  })

  test('l’année reçue n’est jamais modifiée', () => {
    withPrice(known, 2026, 14, 8)
    withPrice(known, 2026, 8, 4)
    expect(known).toEqual({ year: 2026, first: 10, prices: [5, 6] })
  })
})

describe('historique rangé par année, puis relu', () => {
  test('à cheval sur deux années : chaque prix garde son jour', () => {
    const years = [
      { year: 2025, first: 363, prices: [1] },
      { year: 2026, first: 0, prices: [2, 3] },
    ]
    expect(joinYears(years)).toEqual({ from: '2025-12-30', prices: [1, null, 2, 3] })
  })

  test('une année entière sans prix : les jours vides reviennent tels quels', () => {
    const years = [
      { year: 2024, first: 365, prices: [1] },
      { year: 2026, first: 0, prices: [2] },
    ]
    expect(joinYears(years)).toEqual({
      from: '2024-12-31',
      prices: [1, ...Array<null>(365).fill(null), 2],
    })
  })

  test('l’historique part du premier jour avec un prix', () => {
    expect(joinYears([{ year: 2026, first: 2, prices: [5] }])).toEqual({
      from: '2026-01-03',
      prices: [5],
    })
  })

  test('jour après jour, la tâche et la relecture s’accordent', () => {
    // Trois relevés, dont un oublié et un passage au 1er janvier.
    let years: HistoryYear[] = []
    for (const [date, price] of [
      ['2025-12-30', 10],
      ['2026-01-01', 12],
      ['2026-01-02', 11],
    ] as const) {
      const [year, day] = yearDay(date)
      const known = years.find((row) => row.year === year)
      const next = withPrice(known, year, day, price)
      years = [...years.filter((row) => row.year !== year), next].sort((a, b) => a.year - b.year)
    }
    expect(joinYears(years)).toEqual({ from: '2025-12-30', prices: [10, null, 12, 11] })
  })

  test('sans aucun prix : pas d’historique', () => {
    expect(joinYears([])).toBeNull()
  })
})

describe('le prix d’il y a 30 jours', () => {
  const years: HistoryYear[] = [
    { year: 2025, first: 360, prices: [1, null, 2] },
    { year: 2026, first: 280, prices: [3, null, 4] },
  ]

  test('le jour même, sinon le jour avec un prix le plus proche avant, une semaine au plus', () => {
    // 30 jours avant le 7 novembre 2026 (jour 310) : le 8 octobre, jour 280.
    expect(priceBefore(years, '2026-11-07')).toBe(3)
    // 30 jours avant le 8 novembre : le 9 octobre, sans prix ; le 8, oui.
    expect(priceBefore(years, '2026-11-08')).toBe(3)
    // D'une année sur l'autre : 30 jours avant le 31 janvier 2026, le 1er janvier sans prix, ni
    // les 31 et 30 décembre 2025 ; le 29 (jour 362), oui.
    expect(priceBefore(years, '2026-01-31')).toBe(2)
    // Rien dans la semaine : pas de prix.
    expect(priceBefore(years, '2026-06-01')).toBeNull()
  })
})

/** Les années d'une carte en base, sans leur texte. */
const yearsOf = async (id: number) =>
  (await readYears([id], [2025, 2026])).map(({ year, first, prices }) => ({ year, first, prices }))

const run = (...sql: string[]) => env.DB.batch(sql.map((query) => env.DB.prepare(query)))

/** Le relevé du 14 octobre (jour 286) : 10, pour la carte 1. */
const reset = () =>
  run(
    'DELETE FROM cardmarket_history',
    'DELETE FROM cardmarket_prices',
    "INSERT OR REPLACE INTO sources (name, stamp, date) VALUES ('cardmarket', 'mardi', '2026-10-14')",
    "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (1, 2026, 286, '[10]')",
    'INSERT INTO cardmarket_prices (id, price, low, month_ago) VALUES (1, 10, NULL, NULL)',
  )

/** Le guide des prix du 15 octobre : 11 pour la carte 1 (la tâche `prices`). */
const nextGuide: PriceGuide = {
  createdAt: '2026-10-15T03:00:00+0200',
  priceGuides: [
    { idProduct: 1, idCategory: 51, trend: null, avg1: null, avg7: null, avg30: 11, low: null },
  ],
}

describe('mergeHistory : des prix repris de Pokécardex', () => {
  test('chaque jour avant le dernier relevé prend son prix ; celui-là et les suivants restent', async () => {
    await reset()
    await run("UPDATE cardmarket_history SET prices = '[10,11]' WHERE id = 1")
    const written = await mergeHistory(1, [
      ['2025-12-31', 5],
      ['2026-10-12', 8],
      ['2026-10-14', 9],
      ['2026-10-15', 9],
    ])
    expect(written).toBe(2)
    expect(await yearsOf(1)).toEqual([
      { year: 2025, first: 364, prices: [5] },
      { year: 2026, first: 284, prices: [8, null, 10, 11] },
    ])
  })

  test('un jour déjà au même prix : rien de réécrit ; une autre carte : intacte', async () => {
    await reset()
    await run(
      "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (2, 2026, 280, '[4]')",
      "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (3, 2026, 280, '[7]')",
    )
    expect(await mergeHistory(2, [['2026-10-08', 4]])).toBe(0)
    expect(await yearsOf(3)).toEqual([{ year: 2026, first: 280, prices: [7] }])
  })

  test('après le relevé du jour : le relevé garde le dernier mot, et le prix d’il y a 30 jours suit', async () => {
    await reset()
    await savePriceGuide(nextGuide, null, 'mercredi')
    const days = await mergeHistory(1, [
      ['2026-09-14', 4],
      ['2026-09-15', 5],
      ['2026-10-13', 9],
      ['2026-10-14', 8],
      ['2026-10-15', 7],
    ])
    // Le relevé du 15 garde le dernier mot (11) ; les jours d'avant prennent le prix repris.
    expect(days).toBe(4)
    expect(await yearsOf(1)).toEqual([
      { year: 2026, first: 256, prices: [4, 5, ...Array<null>(27).fill(null), 9, 8, 11] },
    ])
    // Celui du 15 septembre, 30 jours avant le dernier relevé.
    expect(
      await env.DB.prepare(
        'SELECT month_ago AS monthAgo FROM cardmarket_prices WHERE id = 1',
      ).first(),
    ).toEqual({ monthAgo: 5 })
  })
})

describe('writeYears : deux tâches sur la même année', () => {
  test('une année changée par l’autre tâche depuis sa lecture n’est pas réécrite : rendue, à refaire', async () => {
    await reset()
    // La reprise lit l'année ; la tâche `prices` y écrit le prix du 15 octobre entre-temps.
    const [read] = await readYears([1], [2026])
    await savePriceGuide(nextGuide, null, 'mercredi')
    const stale = { id: 1, year: 2026, first: 285, prices: '[9,10]', old: read!.text }
    // Une année qui n'existait pas à sa lecture, que l'autre tâche a écrite entre-temps.
    await run(
      "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (2, 2026, 280, '[4]')",
    )
    const missing = { id: 2, year: 2026, first: 279, prices: '[3,4]', old: null }
    const fresh = { id: 3, year: 2026, first: 280, prices: '[7]', old: null }
    expect(await writeYears([stale, missing, fresh])).toEqual([stale, missing])
    // Le prix du jour est toujours là ; seule l'année neuve est écrite.
    expect(await yearsOf(1)).toEqual([{ year: 2026, first: 286, prices: [10, 11] }])
    expect(await yearsOf(2)).toEqual([{ year: 2026, first: 280, prices: [4] }])
    expect(await yearsOf(3)).toEqual([{ year: 2026, first: 280, prices: [7] }])
  })
})

describe('historyTodo : les cartes à reprendre', () => {
  const addSet = (lang: string, id: string, released: string) =>
    env.DB.prepare(
      "INSERT INTO sets (lang, id, name, released, read_at) VALUES (?, ?, 'Série', ?, '2026-10-22')",
    ).bind(lang, id, released)
  const addCard = (lang: string, id: number, set: string, cardmarket: number) =>
    env.DB.prepare(
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       VALUES (?, ?, ?, '1', 1, 'Carte', ?, '2026-10-22')`,
    ).bind(lang, id, set, cardmarket)

  test('la reprise d’une carte japonaise ne saute pas la française au même id', async () => {
    // La carte 7091 de chaque langue : la japonaise déjà lue, la française pas encore.
    await env.DB.batch([
      addSet('ja', 'SM4A', '2018-05-01'),
      addSet('fr', 'BS', '1999-10-20'),
      addCard('ja', 7091, 'SM4A', 4001),
      addCard('fr', 7091, 'BS', 4002),
      env.DB.prepare(
        "INSERT INTO history_imports (lang, card, read_at) VALUES ('ja', 7091, '2026-10-22')",
      ),
    ])
    expect(await historyTodo(null)).toEqual([
      { released: '1999-10-20', lang: 'fr', id: 7091, cardmarket: 4002 },
    ])
  })

  test('sans id Cardmarket, rien à reprendre ; les séries les plus récentes d’abord, puis la suite', async () => {
    await env.DB.batch([
      addSet('fr', 'MEG', '2025-09-26'),
      addSet('ja', 'M1L', '2025-09-26'),
      addCard('fr', 100, 'MEG', 0),
      addCard('fr', 101, 'MEG', 4003),
      addCard('ja', 50, 'M1L', 4004),
    ])
    const todo = await historyTodo(null)
    expect(todo).toEqual([
      { released: '2025-09-26', lang: 'fr', id: 101, cardmarket: 4003 },
      { released: '2025-09-26', lang: 'ja', id: 50, cardmarket: 4004 },
      { released: '1999-10-20', lang: 'fr', id: 7091, cardmarket: 4002 },
    ])
    // L'étape suivante reprend après la dernière carte de la précédente, rien de sauté.
    expect(await historyTodo(todo[0]!)).toEqual(todo.slice(1))
    expect(await historyTodo(todo[1]!)).toEqual(todo.slice(2))
    expect(await historyTodo(todo[2]!)).toEqual([])
  })
})

describe('mainHistory : la courbe de la carte dans sa page Pokécardex', () => {
  /** Une page de carte, réduite à ce qu'on en lit (la forme de Pokécardex, octobre 2026). */
  const page = (main: string, periods: Record<string, PokecardexHistory['points']>) => ({
    carte: {
      cardmarketPrices: [
        { id_cardmarket: main, id_version: null },
        { id_cardmarket: '837231', id_version: 104 },
      ],
      priceHistory: {
        cardmarket: Object.fromEntries(
          Object.entries(periods).map(([days, points]) => [
            days,
            {
              series: [
                {
                  id: 'v_null_normale_avg30',
                  versionId: null,
                  variant: 'normale',
                  metric: 'avg30',
                },
                {
                  id: 'v_null_reverse_avg30',
                  versionId: null,
                  variant: 'reverse',
                  metric: 'avg30',
                },
                { id: 'v_104_normale_avg30', versionId: 104, variant: 'normale', metric: 'avg30' },
              ],
              points,
            },
          ]),
        ),
      },
    },
  })
  const points: PokecardexHistory['points'] = [
    {
      date: '2026-04-22',
      v_null_normale_avg30: 1.944,
      v_null_reverse_avg30: 6.54,
      v_104_normale_avg30: 26,
    },
    { date: '2026-04-23', v_null_reverse_avg30: 6.54, v_104_normale_avg30: 26 },
    { date: '2026-04-24', v_null_normale_avg30: 0, v_104_normale_avg30: 26 },
    { date: '2026-04-25', v_null_normale_avg30: 2.49 },
  ]

  test('la plus longue période, la carte elle-même : ni sa variante ni ses versions', () => {
    const read = mainHistory(page('719442', { '15': points.slice(3), '180': points }), 719442)
    expect(read).toEqual([
      ['2026-04-22', 1.94],
      ['2026-04-25', 2.49],
    ])
  })

  test('seulement les jours écrits AAAA-MM-JJ : une autre forme ne prend jamais un jour décalé', () => {
    // `2026-04-23T00:00:00+02:00` tomberait au jour 111,9 : une ligne au premier jour fractionnaire,
    // où chaque prix du jour suivant se perdrait.
    const dated = (date: string) => ({ date, v_null_normale_avg30: 3 })
    const read = mainHistory(
      page('719442', {
        '180': [
          dated('2026-04-22'),
          dated('2026-04-23T00:00:00+02:00'),
          dated('2026-04-24 00:00:00'),
          dated('24/04/2026'),
          dated('2026-04-25'),
        ],
      }),
      719442,
    )
    expect(read).toEqual([
      ['2026-04-22', 3],
      ['2026-04-25', 3],
    ])
  })

  test('un autre produit Cardmarket que celui du catalogue, ou pas d’historique : rien', () => {
    expect(mainHistory(page('719443', { '180': points }), 719442)).toBeNull()
    expect(mainHistory(page('719442', {}), 719442)).toBeNull()
    expect(mainHistory({ carte: {} }, 719442)).toBeNull()
  })
})
