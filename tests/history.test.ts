/**
 * L'historique des prix (`src/history.ts`) : irremplaçable, Cardmarket n'en garde pas. La tâche
 * `prices` y ajoute chaque jour le prix du jour (`withPrice`) et lit celui d'il y a 30 jours
 * (`priceBefore`), la tâche `history` y reprend celui de Pokécardex des 180 derniers jours
 * (`mainHistory`, `mergePrices` : jamais celui d'une autre version, jamais le relevé du jour
 * remplacé), la base le range par année, l'API le rend d'un seul tenant (`joinYears`,
 * `historyReader`), pour une carte comme pour toute la collection : aucun prix ne doit se perdre,
 * changer de jour en route, ni passer d'une carte à une autre. La reprise d'une carte pendant que
 * la tâche `prices` écrit le relevé du jour, dans un autre processus (`mergeHistory`), ne l'efface
 * pas ; seuls des jours écrits AAAA-MM-JJ sont repris. La reprise (`historyTodo`) suit la langue :
 * l'id d'une carte japonaise lue ne fait pas sauter la française au même id.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  historyReader,
  historyStore,
  joinYears,
  mergePrices,
  priceBefore,
  withPrice,
  yearDay,
  type HistoryYear,
} from '../src/history'
import { DATA_DIR, DATA_STEPS, migrate, readSource, writeSource } from '../src/db'
import { historyTodo, mainHistory, mergeHistory } from '../src/jobs/history'
import type { PriceGuide, ProductList } from '../src/jobs/prices'
import type { PokecardexHistory } from '../src/lib/pokecardex'
// Pour sa garde : la base de la course va dans le dossier temporaire de `setup.ts`.
import './server'

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

describe('historyReader', () => {
  // Les seules colonnes que lit l'API (le schéma complet : `src/db.ts`).
  const db = new Database(':memory:')
  db.run(`CREATE TABLE cardmarket_products (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
  db.run(`CREATE TABLE cardmarket_history (
    id INTEGER NOT NULL, year INTEGER NOT NULL, first INTEGER NOT NULL, prices TEXT NOT NULL,
    PRIMARY KEY (id, year))`)
  const year = db.query('INSERT INTO cardmarket_history VALUES (?, ?, ?, ?)')
  year.run(719621, 2026, 0, '[2,3]')
  year.run(719621, 2025, 363, '[1]')
  year.run(719446, 2026, 286, '[7]')
  db.run(`INSERT INTO cardmarket_products VALUES (719621, 'Charmander [Blazing Destruction]')`)
  const read = historyReader(db)

  test('chaque carte son historique, ses années dans l’ordre, avec son nom', () => {
    expect(read(719621)).toEqual({
      name: 'Charmander [Blazing Destruction]',
      from: '2025-12-30',
      prices: [1, null, 2, 3],
    })
    expect(read(719446)).toEqual({ name: null, from: '2026-10-14', prices: [7] })
  })

  test('une carte sans historique : rien, jamais celui d’une autre', () => {
    expect(read(1)).toBeNull()
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

describe('mergePrices : des prix repris d’ailleurs (Pokécardex)', () => {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE cardmarket_history (
    id INTEGER NOT NULL, year INTEGER NOT NULL, first INTEGER NOT NULL, prices TEXT NOT NULL,
    PRIMARY KEY (id, year))`)
  const store = historyStore(db)

  test('chaque jour avant le dernier relevé prend son prix ; celui-là et les suivants restent', () => {
    // Le relevé : le 14 octobre (jour 286), puis le 15.
    store.save(1, { year: 2026, first: 286, prices: [10, 11] })
    const written = mergePrices(
      db,
      1,
      [
        ['2025-12-31', 5],
        ['2026-10-12', 8],
        ['2026-10-14', 9],
        ['2026-10-15', 9],
      ],
      '2026-10-14',
    )
    expect(written).toBe(2)
    expect(store.year(1, 2025)).toEqual({ year: 2025, first: 364, prices: [5] })
    expect(store.year(1, 2026)).toEqual({ year: 2026, first: 284, prices: [8, null, 10, 11] })
  })

  test('un jour déjà au même prix : rien de réécrit ; une autre carte : intacte', () => {
    store.save(2, { year: 2026, first: 280, prices: [4] })
    store.save(3, { year: 2026, first: 280, prices: [7] })
    expect(mergePrices(db, 2, [['2026-10-08', 4]], null)).toBe(0)
    expect(store.year(3, 2026)).toEqual({ year: 2026, first: 280, prices: [7] })
  })
})

describe('mergeHistory : la reprise pendant le relevé du jour', () => {
  // Deux processus, comme sur le VPS : la tâche `prices` (le service `ingest`) écrit le guide du
  // jour pendant que la tâche `history` (le conteneur `cards`) reprend une carte au même produit.
  test('le prix du jour que la tâche `prices` écrit pendant la reprise n’est jamais perdu', async () => {
    const file = join(DATA_DIR, 'course.db')
    const marker = join(DATA_DIR, 'course-verrou')
    // Réglée comme `openData` : une écriture attend 5 s au plus le verrou de l'autre processus.
    const db = new Database(file, { create: true, strict: true })
    db.run('PRAGMA busy_timeout = 5000')
    db.run('PRAGMA journal_mode = WAL')
    migrate(db, 'course', DATA_STEPS)
    try {
      const store = historyStore(db)
      // Le relevé du 14 octobre (jour 286) : 10.
      writeSource(db, 'cardmarket', { stamp: 'mardi', date: '2026-10-14' })
      db.run('INSERT INTO cardmarket_prices (id, price, low, month_ago) VALUES (1, 10, NULL, NULL)')
      store.save(1, { year: 2026, first: 286, prices: [10] })

      // La tâche `prices`, dans un autre processus : le guide du 15 octobre (11), dans une
      // transaction qu'elle garde ouverte une demi-seconde (le vrai guide en prend presque une).
      const guide: PriceGuide = {
        createdAt: '2026-10-15T03:00:00+0200',
        priceGuides: [
          {
            idProduct: 1,
            idCategory: 51,
            trend: null,
            avg1: null,
            avg7: null,
            avg30: 11,
            low: null,
          },
        ],
      }
      const products: ProductList = {
        products: [{ idProduct: 1, name: 'Carte 1', idExpansion: 7, idMetacard: 1 }],
      }
      const prices = Bun.spawn(
        [
          process.execPath,
          '-e',
          `import { Database } from 'bun:sqlite'
         import { writeFileSync } from 'node:fs'
         import { savePriceGuide } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, '../src/jobs/prices.ts')).href)}
         const db = new Database(${JSON.stringify(file)}, { strict: true })
         db.run('PRAGMA busy_timeout = 5000')
         db.transaction(() => {
           savePriceGuide(db, ${JSON.stringify(guide)}, ${JSON.stringify(products)}, 'mercredi')
           writeFileSync(${JSON.stringify(marker)}, '')
           Bun.sleepSync(500)
         }).immediate()`,
        ],
        { stdout: 'inherit', stderr: 'inherit' },
      )
      while (!existsSync(marker)) await Bun.sleep(10)

      // Pendant ce temps, la reprise de la carte : les jours de Pokécardex, dont le 14 et le 15.
      const days = mergeHistory(db, 1, [
        ['2026-09-14', 4],
        ['2026-09-15', 5],
        ['2026-10-13', 9],
        ['2026-10-14', 8],
        ['2026-10-15', 7],
      ])
      expect(await prices.exited).toBe(0)

      // Le relevé du 15 garde le dernier mot (11) ; les jours d'avant prennent le prix repris.
      expect(readSource(db, 'cardmarket')).toEqual({ stamp: 'mercredi', date: '2026-10-15' })
      expect(store.year(1, 2026)).toEqual({
        year: 2026,
        first: 256,
        prices: [4, 5, ...Array<null>(27).fill(null), 9, 8, 11],
      })
      expect(days).toBe(4)
      // Le prix d'il y a 30 jours, celui du 15 septembre : d'après le relevé du 15 octobre.
      expect(
        db.query('SELECT month_ago AS monthAgo FROM cardmarket_prices WHERE id = 1').get(),
      ).toEqual({ monthAgo: 5 })
    } finally {
      db.close()
    }
  })
})

describe('historyTodo : les cartes à reprendre', () => {
  const db = new Database(':memory:', { strict: true })
  // Comme `openData` : les clés étrangères actives.
  db.run('PRAGMA foreign_keys = ON')
  migrate(db, 'essai', DATA_STEPS)
  const addSet = db.query(
    "INSERT INTO sets (lang, id, name, released, read_at) VALUES (?, ?, 'Série', ?, '2026-10-22')",
  )
  const addCard = db.query(
    `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
     VALUES (?, ?, ?, '1', 1, 'Carte', ?, '2026-10-22')`,
  )

  test('la reprise d’une carte japonaise ne saute pas la française au même id', () => {
    // La carte 7091 de chaque langue : la japonaise déjà lue, la française pas encore.
    addSet.run('ja', 'SM4A', '2018-05-01')
    addSet.run('fr', 'BS', '1999-10-20')
    addCard.run('ja', 7091, 'SM4A', 4001)
    addCard.run('fr', 7091, 'BS', 4002)
    db.run("INSERT INTO history_imports (lang, card, read_at) VALUES ('ja', 7091, '2026-10-22')")
    expect(historyTodo(db)).toEqual([{ lang: 'fr', id: 7091, cardmarket: 4002 }])
  })

  test('sans id Cardmarket, rien à reprendre ; les séries les plus récentes d’abord', () => {
    addSet.run('fr', 'MEG', '2025-09-26')
    addCard.run('fr', 100, 'MEG', 0)
    addCard.run('fr', 101, 'MEG', 4003)
    expect(historyTodo(db)).toEqual([
      { lang: 'fr', id: 101, cardmarket: 4003 },
      { lang: 'fr', id: 7091, cardmarket: 4002 },
    ])
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
