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
