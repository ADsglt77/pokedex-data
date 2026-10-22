/**
 * La ligne d'une carte pour la liste de souhaits Cardmarket (« Ajouter une deck list »), avant son
 * Shopping Wizard : une mauvaise version ou une mauvaise extension achèterait une autre carte. Pas
 * de ligne plutôt qu'une ligne douteuse : l'utilisateur ajoute alors la carte depuis sa page.
 */

import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { wantsLine, wantsVersion } from '@/lib/wants'
import { referenceRoutes } from '../src/reference'
import { testData } from './server'

const CHARMANDER = 'Charmander [Blazing Destruction | Steady Firebreathing]'
const TOXTRICITY = 'Toxtricity VMAX [G-Max Riot]'
const BULBASAUR = 'Bulbasaur [Bind Down]'
/** Le seul nom d’une extension, qu’aucune autre ne porte. */
const only = (name: string) => [{ name, expansions: 1 }]

describe('wantsVersion', () => {
  test('rang du numéro imprimé, en nombre : ni l’ordre des ids ni celui du texte', () => {
    // Rebellion Crash : S2 037 (464059) est la V.1 bien que créée après S2 107 (464054).
    expect(wantsVersion('037', ['107', '037'])).toBe(1)
    expect(wantsVersion('107', ['107', '037'])).toBe(2)
    // En texte, « 10 » viendrait avant « 9 ».
    expect(wantsVersion('9', ['10', '9'])).toBe(1)
    expect(wantsVersion('10', ['10', '9'])).toBe(2)
    // Dracaufeu ex de Pokémon Card 151 : sv2a 006, 185 et 201.
    expect(wantsVersion('201', ['006', '185', '201'])).toBe(3)
  })

  test('un numéro inconnu, pas fait que de chiffres, ou partagé : pas de version', () => {
    expect(wantsVersion('004', ['004', null])).toBeNull()
    expect(wantsVersion(null, ['004', null])).toBeNull()
    expect(wantsVersion('004', ['004', 'TG01'])).toBeNull()
    expect(wantsVersion('SV-P', ['004', 'SV-P'])).toBeNull()
    expect(wantsVersion('004', ['004', ''])).toBeNull()
    expect(wantsVersion('004', ['004', '004'])).toBeNull()
    // Le même nombre écrit autrement : à égalité aussi.
    expect(wantsVersion('037', ['037', '37'])).toBeNull()
  })
})

describe('wantsLine', () => {
  test('la ligne vérifiée sur cardmarket.com : 719621, sv2a 168, seconde version', () => {
    expect(
      wantsLine({ name: CHARMANDER, number: '168' }, ['004', '168'], only('Pokémon Card 151')),
    ).toBe('1x Charmander Blazing Destruction Steady Firebreathing (V.2) (Pokémon Card 151)')
    expect(
      wantsLine({ name: CHARMANDER, number: '004' }, ['004', '168'], only('Pokémon Card 151')),
    ).toBe('1x Charmander Blazing Destruction Steady Firebreathing (V.1) (Pokémon Card 151)')
  })

  test('les versions par numéro imprimé : Toxtricity VMAX de Rebellion Crash', () => {
    expect(
      wantsLine({ name: TOXTRICITY, number: '037' }, ['107', '037'], only('Rebellion Crash')),
    ).toBe('1x Toxtricity VMAX G-Max Riot (V.1) (Rebellion Crash)')
    expect(
      wantsLine({ name: TOXTRICITY, number: '107' }, ['107', '037'], only('Rebellion Crash')),
    ).toBe('1x Toxtricity VMAX G-Max Riot (V.2) (Rebellion Crash)')
  })

  test('seul de sa carte dans l’extension : sans version, même absent du catalogue', () => {
    const name = 'Karrablast [Continuous Headbutt]'
    expect(wantsLine({ name, number: '003' }, ['003'], only('Explosive Walker'))).toBe(
      '1x Karrablast Continuous Headbutt (Explosive Walker)',
    )
    expect(wantsLine({ name, number: null }, [null], only('Explosive Walker'))).toBe(
      '1x Karrablast Continuous Headbutt (Explosive Walker)',
    )
  })

  test('plusieurs « | », un nom sans crochets', () => {
    expect(
      wantsLine(
        { name: 'Ho-Oh [Stoke | Sacred Fire | Dive Bomb]', number: '' },
        [''],
        only('Awakening Legends'),
      ),
    ).toBe('1x Ho-Oh Stoke Sacred Fire Dive Bomb (Awakening Legends)')
    expect(wantsLine({ name: 'Scoop Up Net', number: null }, [null], only('Rebellion Crash'))).toBe(
      '1x Scoop Up Net (Rebellion Crash)',
    )
  })

  test('le nom d’extension sans les espaces que Pokécardex laisse au bout', () => {
    expect(
      wantsLine(
        { name: 'Bulbasaur [Razor Leaf]', number: '001' },
        ['001'],
        only('Shining Legends  '),
      ),
    ).toBe('1x Bulbasaur Razor Leaf (Shining Legends)')
  })

  test('une version incertaine : pas de ligne, plutôt que la V.1 d’une autre carte', () => {
    const product = { name: CHARMANDER, number: '168' }
    const expansion = only('Pokémon Card 151')
    expect(wantsLine(product, ['004', '168', null], expansion)).toBeNull()
    expect(wantsLine(product, ['TG01', '168'], expansion)).toBeNull()
    expect(wantsLine(product, ['168', '168'], expansion)).toBeNull()
    expect(wantsLine({ name: CHARMANDER, number: null }, ['004', null], expansion)).toBeNull()
  })

  test('aucun ou plusieurs noms d’extension : pas de ligne (Cardmarket prendrait toutes versions)', () => {
    const product = { name: 'Karrablast [Continuous Headbutt]', number: '003' }
    expect(wantsLine(product, ['003'], [])).toBeNull()
    expect(wantsLine(product, ['003'], [...only('S-P Promotional'), ...only('Jumbo')])).toBeNull()
    // Deux noms qui ne diffèrent que par une espace : deux noms aussi.
    expect(
      wantsLine(product, ['003'], [...only('Explosive Walker'), ...only('Explosive Walker ')]),
    ).toBeNull()
  })

  test('un nom que porte aussi une autre extension : pas de ligne (laquelle des deux ?)', () => {
    // Deux séries « Beginning Set » (HS, 2010 ; HXY, 2013), chacune d’une autre extension.
    const chespin = { name: 'Chespin [Vine Whip | Seed Bomb]', number: '003' }
    expect(wantsLine(chespin, ['003'], [{ name: 'Beginning Set', expansions: 2 }])).toBeNull()
    // « Jumbo », seul nom de cette extension, mais réparti sur sept.
    const celebi = { name: 'Timeless Celebi [Reviving Light]', number: null }
    expect(wantsLine(celebi, [null], [{ name: 'Jumbo', expansions: 7 }])).toBeNull()
  })

  test('une parenthèse dans le nom ou l’extension : pas de ligne (Cardmarket la lirait mal)', () => {
    const imakuni = 'Imakuni?\'s Loudred [DecaVoice | ""______"" (←Write your name)]'
    expect(wantsLine({ name: imakuni, number: '023' }, ['023'], only('T Promotional'))).toBeNull()
    expect(
      wantsLine(
        { name: 'Arbok [Wrap | Deadly Poison]', number: null },
        [null],
        only('Vending Machine (Green)'),
      ),
    ).toBeNull()
  })
})

describe('/v1/wants : les lignes tirées de la base (produits, catalogue, extensions)', () => {
  const data = testData()
  const api = new Elysia().group('/v1', (group) => group.use(referenceRoutes(data)))
  const wants = async (ids: string) =>
    (await api.handle(new Request(`http://localhost/v1/wants?ids=${ids}`))).json()

  /** Rebellion Crash, ses deux Toxtricity VMAX (037 et 107), et deux produits sans ligne sûre. */
  function seed() {
    data.run("DELETE FROM cards WHERE set_id = 'ZZS2'")
    data.run("DELETE FROM sets WHERE id = 'ZZS2'")
    data.run('DELETE FROM cardmarket_products WHERE id BETWEEN 464054 AND 464061')
    // Pour une japonaise, le nom de son extension est son nom (`expansion_name`).
    data.run(
      "INSERT INTO sets (lang, id, name, released, read_at, expansion_name) VALUES ('ja', 'ZZS2', 'Rebellion Crash', '2019-12-06', '2026-10-01', 'Rebellion Crash')",
    )
    const card = data.query(
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       VALUES ('ja', ?, 'ZZS2', ?, ?, 'Toxtricity VMAX', ?, '2026-10-01')`,
    )
    card.run(990037, '037', 37, 464059)
    card.run(990107, '107', 107, 464054)
    const product = data.query(
      'INSERT INTO cardmarket_products (id, name, expansion, metacard) VALUES (?, ?, ?, ?)',
    )
    product.run(464059, TOXTRICITY, 2800, 77)
    product.run(464054, TOXTRICITY, 2800, 77)
    // Retiré de la liste des produits : plus d'extension.
    product.run(464060, 'Scoop Up Net', null, null)
    // Sans métacarte (une ligne d'avant sa colonne) : pas de version sûre.
    product.run(464061, CHARMANDER, 2800, null)
  }

  test('la version dans l’ordre des numéros imprimés, l’extension d’après le catalogue', async () => {
    seed()
    expect(await wants('464059,464054')).toEqual({
      '464059': '1x Toxtricity VMAX G-Max Riot (V.1) (Rebellion Crash)',
      '464054': '1x Toxtricity VMAX G-Max Riot (V.2) (Rebellion Crash)',
    })
  })

  test('un produit retiré, sans métacarte, ou inconnu : pas de ligne (jamais une autre carte)', async () => {
    seed()
    expect(await wants('464060,464061,1')).toEqual({ '464060': null, '464061': null, '1': null })
  })

  /**
   * Des cartes françaises : « Mega Evolution » (extension 2900, le nom anglais de sa série), une
   * série sans nom d'extension (2901), et une japonaise de même code que la française mais d'une
   * autre extension (2903), le code d'une série se répétant d'une langue à l'autre.
   */
  function seedFrench() {
    data.run("DELETE FROM cards WHERE set_id LIKE 'ZZX%'")
    data.run("DELETE FROM sets WHERE id LIKE 'ZZX%'")
    data.run('DELETE FROM cardmarket_products WHERE id BETWEEN 464070 AND 464079')
    const set = data.query(
      `INSERT INTO sets (lang, id, name, released, read_at, expansion_name)
       VALUES (?, ?, ?, '2025-09-26', '2026-10-01', ?)`,
    )
    set.run('fr', 'ZZXMEG', 'Méga-Évolution', 'Mega Evolution')
    set.run('fr', 'ZZXASC', 'Héros Transcendants', '')
    set.run('ja', 'ZZXMEG', 'Mega Brave', 'Mega Brave')
    const card = data.query(
      `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
       VALUES (?, ?, ?, '001', 1, 'Bulbizarre', ?, '2026-10-01')`,
    )
    card.run('fr', 990201, 'ZZXMEG', 464070)
    card.run('fr', 990202, 'ZZXASC', 464071)
    card.run('ja', 990203, 'ZZXMEG', 464073)
    const product = data.query(
      'INSERT INTO cardmarket_products (id, name, expansion, metacard) VALUES (?, ?, ?, ?)',
    )
    product.run(464070, BULBASAUR, 2900, 90)
    product.run(464071, BULBASAUR, 2901, 90)
    product.run(464073, BULBASAUR, 2903, 90)
  }

  test('une carte française : le nom anglais de l’extension de sa série', async () => {
    seedFrench()
    expect(await wants('464070')).toEqual({
      '464070': '1x Bulbasaur Bind Down (Mega Evolution)',
    })
  })

  test('une série française sans nom d’extension : pas de ligne (jamais son nom français)', async () => {
    seedFrench()
    expect(await wants('464071')).toEqual({ '464071': null })
  })

  test('le code d’une série dans les deux langues : chaque carte a le nom de sa langue', async () => {
    seedFrench()
    expect(await wants('464070,464073')).toEqual({
      '464070': '1x Bulbasaur Bind Down (Mega Evolution)',
      '464073': '1x Bulbasaur Bind Down (Mega Brave)',
    })
  })

  test('un nom que portent une série française et une japonaise d’extensions différentes : pas de ligne', async () => {
    seedFrench()
    // Une série japonaise de même nom d'extension que la française, mais d'une autre extension.
    data.run(
      "INSERT INTO sets (lang, id, name, released, read_at, expansion_name) VALUES ('ja', 'ZZXJ', 'Mega Evolution', '2025-09-26', '2026-10-01', 'Mega Evolution')",
    )
    data.run(
      "INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen) VALUES ('ja', 990204, 'ZZXJ', '001', 1, 'Fushigidane', 464074, '2026-10-01')",
    )
    data.run(
      'INSERT INTO cardmarket_products (id, name, expansion, metacard) VALUES (464074, ?, 2904, 91)',
      [BULBASAUR],
    )
    expect(await wants('464070,464074')).toEqual({ '464070': null, '464074': null })
  })

  test('une série française et une japonaise d’une même extension et d’un même nom : une ligne', async () => {
    seedFrench()
    // Le produit partagé par les deux langues est d'une seule extension : un seul nom, un seul compte.
    data.run(
      "INSERT INTO sets (lang, id, name, released, read_at, expansion_name) VALUES ('ja', 'ZZXJ', 'Mega Evolution', '2025-09-26', '2026-10-01', 'Mega Evolution')",
    )
    data.run(
      "INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen) VALUES ('ja', 990204, 'ZZXJ', '001', 1, 'Fushigidane', 464070, '2026-10-01')",
    )
    expect(await wants('464070')).toEqual({
      '464070': '1x Bulbasaur Bind Down (Mega Evolution)',
    })
  })
})
