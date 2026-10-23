/**
 * Les étapes du schéma de la base (`src/db.ts`) : une base existante garde ses lignes en passant
 * les étapes suivantes (l'historique des prix est irremplaçable) ; une étape modifiée après son
 * application, ou une base plus avancée que le code, et rien n'est appliqué.
 */

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { DATA_STEPS, migrate } from '../src/db'

const version = (db: Database) =>
  (db.query('PRAGMA user_version').get() as { user_version: number }).user_version

describe('migrate', () => {
  test('une base remplie à une étape ancienne garde ses lignes jusqu’à la dernière', () => {
    const data = new Database(':memory:')
    migrate(data, 'data.db', DATA_STEPS.slice(0, 1))
    data.run(
      "INSERT INTO cardmarket_history (id, year, first, prices) VALUES (719445, 2026, 285, '[6.87,7.1]')",
    )
    migrate(data, 'data.db', DATA_STEPS)
    expect(version(data)).toBe(DATA_STEPS.length)
    expect(data.query('SELECT * FROM cardmarket_history').all()).toEqual([
      { id: 719445, year: 2026, first: 285, prices: '[6.87,7.1]' },
    ])
  })

  test('la langue entre dans les clés du catalogue, sans rien perdre', () => {
    const db = new Database(':memory:', { strict: true })
    // Comme `openData` : l'étape passe avec les clés étrangères actives.
    db.run('PRAGMA foreign_keys = ON')
    const insert = (table: string, row: Record<string, string | number>) => {
      const columns = Object.keys(row)
      db.query(
        `INSERT INTO ${table} (${columns}) VALUES (${columns.map((column) => `$${column}`)})`,
      ).run(row)
    }
    // Les 16 premières étapes : celles d'avant la langue (la 17e), quelles que soient les suivantes.
    migrate(db, 'essai', DATA_STEPS.slice(0, 16))
    const set = {
      id: 'SM4A',
      name: 'Ultradimensional Beasts',
      released: '2017-09-15',
      read_at: '2026-10-19T18:54:48.022Z',
      logo: 'pokecardex',
      logo_checked: '2026-10-20T11:59:39.826Z',
      block: 'Sun & Moon Era',
      block_rank: 3,
      deck: 0,
    }
    const card = {
      id: 7091,
      set_id: 'SM4A',
      number: '025',
      sort: 25,
      name: 'Regirock',
      cardmarket: 560271,
      seen: '2026-10-19T18:54:48.022Z',
      image: 'pokecardex',
      image_checked: '2026-10-20T12:24:59.920Z',
      rarity: 9,
      type: 8,
      printed: '025/050',
      name_en: 'Regirock',
      name_de: 'Regirock',
      illustrator: 'kawayoo',
      versions: '["Standard"]',
    }
    insert('sets', set)
    insert('cards', card)
    insert('card_species', { card: 7091, rank: 0, dex_id: 377 })
    insert('history_imports', { card: 7091, read_at: '2026-10-21T08:00:00.000Z' })
    insert('rarities', { id: 48, name: 'FUR', rank: 48 })

    migrate(db, 'essai', DATA_STEPS)
    expect(db.query('SELECT * FROM sets').all()).toEqual([
      { lang: 'ja', ...set, expansion_name: 'Ultradimensional Beasts' },
    ])
    expect(db.query('SELECT * FROM cards').all()).toEqual([{ lang: 'ja', ...card }])
    expect(db.query('SELECT * FROM card_species').all()).toEqual([
      { lang: 'ja', card: 7091, rank: 0, dex_id: 377 },
    ])
    expect(db.query('SELECT * FROM history_imports').all()).toEqual([
      { lang: 'ja', card: 7091, read_at: '2026-10-21T08:00:00.000Z' },
    ])
    expect(db.query('SELECT * FROM rarities').all()).toEqual([
      { lang: 'ja', id: 48, name: 'FUR', rank: 48 },
    ])

    // Les mêmes clés en français : la série SM4A, la carte 7091 (Alakazam), la rareté 48.
    insert('sets', { lang: 'fr', id: 'SM4A', name: 'Set de base', released: '', read_at: '' })
    insert('cards', {
      lang: 'fr',
      id: 7091,
      set_id: 'SM4A',
      number: '1',
      sort: 1,
      name: 'Alakazam',
      cardmarket: 0,
      seen: '',
    })
    insert('card_species', { lang: 'fr', card: 7091, rank: 0, dex_id: 65 })
    insert('history_imports', { lang: 'fr', card: 7091, read_at: '' })
    insert('rarities', { lang: 'fr', id: 48, name: 'Futuriste Rare', rank: 48 })
    expect(db.query('SELECT COUNT(*) AS count FROM cards WHERE id = 7091').get()).toEqual({
      count: 2,
    })
    // La carte japonaise retirée emporte ses Pokémon, pas ceux de la française.
    db.run("DELETE FROM cards WHERE lang = 'ja' AND id = 7091")
    expect(db.query('SELECT lang, dex_id FROM card_species').all()).toEqual([
      { lang: 'fr', dex_id: 65 },
    ])
  })

  test('une étape modifiée après son application : refusée, rien d’appliqué', () => {
    const db = new Database(':memory:')
    migrate(db, 'essai.db', ['CREATE TABLE a (x);'])
    expect(() =>
      migrate(db, 'essai.db', ['CREATE TABLE a (x, y);', 'CREATE TABLE b (z);']),
    ).toThrow('l’étape 1 du schéma a changé')
    expect(version(db)).toBe(1)
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'b'").get()).toBeNull()
  })

  test('une base d’avant les empreintes les reçoit à la prochaine étape, puis est gardée', () => {
    const db = new Database(':memory:')
    // Appliquée comme avant les empreintes : sans `schema_steps`.
    db.run('CREATE TABLE a (x);')
    db.run('PRAGMA user_version = 1')
    migrate(db, 'essai.db', ['CREATE TABLE a (x);', 'CREATE TABLE b (z);'])
    expect(db.query('SELECT step FROM schema_steps ORDER BY step').all()).toEqual([
      { step: 1 },
      { step: 2 },
    ])
    expect(() =>
      migrate(db, 'essai.db', ['CREATE TABLE a (x, y);', 'CREATE TABLE b (z);']),
    ).toThrow('l’étape 1 du schéma a changé')
  })

  test('une base plus avancée que le code (un code plus ancien redéployé) : refusée', () => {
    const db = new Database(':memory:')
    migrate(db, 'essai.db', ['CREATE TABLE a (x);', 'CREATE TABLE b (z);'])
    expect(() => migrate(db, 'essai.db', ['CREATE TABLE a (x);'])).toThrow(
      'en est à l’étape 2 du schéma, ce code n’en connaît que 1',
    )
  })
})
