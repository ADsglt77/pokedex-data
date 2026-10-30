/**
 * La ligne d'une carte pour la liste de souhaits Cardmarket (« Ajouter une deck list », avant son
 * Shopping Wizard : `lib/wants.ts`), et `/v1/wants`, qui la tire de la base (produits, catalogue,
 * extensions). Une mauvaise version ou une mauvaise extension achèterait une autre carte : pas de
 * ligne plutôt qu'une ligne douteuse ; l'utilisateur ajoute alors la carte depuis sa page.
 */

import { env } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'
import { wantsLine, wantsVersion } from '@/lib/wants'
import { app } from '../app'

const CHARMANDER = 'Charmander [Blazing Destruction | Steady Firebreathing]'
const TOXTRICITY = 'Toxtricity VMAX [G-Max Riot]'
const BULBASAUR = 'Bulbasaur [Bind Down]'
/** Le seul nom d’une extension, qu’aucune autre ne porte. */
const only = (name: string) => [{ name, expansions: 1 }]

const wants = async (ids: string) => (await app.request(`/v1/wants?ids=${ids}`)).json()

/** Des requêtes SQL, d'un seul tenant. */
const run = (...statements: (string | [string, ...unknown[]])[]) =>
  env.DB.batch(
    statements.map((statement) =>
      typeof statement === 'string'
        ? env.DB.prepare(statement)
        : env.DB.prepare(statement[0]).bind(...statement.slice(1)),
    ),
  )

const SET = `INSERT INTO sets (lang, id, name, released, read_at, expansion_name)
             VALUES (?, ?, ?, ?, '2026-10-01', ?)`
const CARD = `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
              VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-01')`
const PRODUCT =
  'INSERT INTO cardmarket_products (id, name, expansion, metacard) VALUES (?, ?, ?, ?)'

/** Rebellion Crash, ses deux Toxtricity VMAX (037 et 107), et deux produits sans ligne sûre. */
const seed = () =>
  run(
    "DELETE FROM cards WHERE set_id = 'ZZS2'",
    "DELETE FROM sets WHERE id = 'ZZS2'",
    'DELETE FROM cardmarket_products WHERE id BETWEEN 464054 AND 464061',
    // Pour une japonaise, le nom de son extension est son nom (`expansion_name`).
    [SET, 'ja', 'ZZS2', 'Rebellion Crash', '2019-12-06', 'Rebellion Crash'],
    [CARD, 'ja', 990037, 'ZZS2', '037', 37, 'Toxtricity VMAX', 464059],
    [CARD, 'ja', 990107, 'ZZS2', '107', 107, 'Toxtricity VMAX', 464054],
    [PRODUCT, 464059, TOXTRICITY, 2800, 77],
    [PRODUCT, 464054, TOXTRICITY, 2800, 77],
    // Retiré de la liste des produits : plus d'extension.
    [PRODUCT, 464060, 'Scoop Up Net', null, null],
    // Sans métacarte (une ligne d'avant sa colonne) : pas de version sûre.
    [PRODUCT, 464061, CHARMANDER, 2800, null],
  )

/**
 * Des cartes françaises : « Mega Evolution » (extension 2900, le nom anglais de sa série), une
 * série sans nom d'extension (2901), et une japonaise de même code que la française mais d'une
 * autre extension (2903), le code d'une série se répétant d'une langue à l'autre.
 */
const seedFrench = () =>
  run(
    "DELETE FROM cards WHERE set_id LIKE 'ZZX%'",
    "DELETE FROM sets WHERE id LIKE 'ZZX%'",
    'DELETE FROM cardmarket_products WHERE id BETWEEN 464070 AND 464079',
    [SET, 'fr', 'ZZXMEG', 'Méga-Évolution', '2025-09-26', 'Mega Evolution'],
    [SET, 'fr', 'ZZXASC', 'Héros Transcendants', '2025-09-26', ''],
    [SET, 'ja', 'ZZXMEG', 'Mega Brave', '2025-09-26', 'Mega Brave'],
    [CARD, 'fr', 990201, 'ZZXMEG', '001', 1, 'Bulbizarre', 464070],
    [CARD, 'fr', 990202, 'ZZXASC', '001', 1, 'Bulbizarre', 464071],
    [CARD, 'ja', 990203, 'ZZXMEG', '001', 1, 'Bulbizarre', 464073],
    [PRODUCT, 464070, BULBASAUR, 2900, 90],
    [PRODUCT, 464071, BULBASAUR, 2901, 90],
    [PRODUCT, 464073, BULBASAUR, 2903, 90],
  )

describe('/v1/wants : les lignes tirées de la base (produits, catalogue, extensions)', () => {
  test('la version dans l’ordre des numéros imprimés, l’extension d’après le catalogue', async () => {
    await seed()
    expect(await wants('464059,464054')).toEqual({
      '464059': '1x Toxtricity VMAX G-Max Riot (V.1) (Rebellion Crash)',
      '464054': '1x Toxtricity VMAX G-Max Riot (V.2) (Rebellion Crash)',
    })
  })

  test('un produit retiré, sans métacarte, ou inconnu : pas de ligne (jamais une autre carte)', async () => {
    await seed()
    expect(await wants('464060,464061,1')).toEqual({ '464060': null, '464061': null, '1': null })
  })

  test('une série française sans nom d’extension : pas de ligne (jamais son nom français)', async () => {
    await seedFrench()
    expect(await wants('464071')).toEqual({ '464071': null })
  })

  test('le code d’une série dans les deux langues : chaque carte a le nom de sa langue', async () => {
    await seedFrench()
    expect(await wants('464070,464073')).toEqual({
      '464070': '1x Bulbasaur Bind Down (Mega Evolution)',
      '464073': '1x Bulbasaur Bind Down (Mega Brave)',
    })
  })

  test('un nom que portent une série française et une japonaise d’extensions différentes : pas de ligne', async () => {
    await seedFrench()
    // Une série japonaise de même nom d'extension que la française, mais d'une autre extension.
    await run(
      [SET, 'ja', 'ZZXJ', 'Mega Evolution', '2025-09-26', 'Mega Evolution'],
      [CARD, 'ja', 990204, 'ZZXJ', '001', 1, 'Fushigidane', 464074],
      [PRODUCT, 464074, BULBASAUR, 2904, 91],
    )
    expect(await wants('464070,464074')).toEqual({ '464070': null, '464074': null })
  })

  test('une série française et une japonaise d’une même extension et d’un même nom : une ligne', async () => {
    await seedFrench()
    // Le produit partagé par les deux langues est d'une seule extension : un seul nom, un seul compte.
    await run(
      [SET, 'ja', 'ZZXJ', 'Mega Evolution', '2025-09-26', 'Mega Evolution'],
      [CARD, 'ja', 990204, 'ZZXJ', '001', 1, 'Fushigidane', 464070],
    )
    expect(await wants('464070')).toEqual({
      '464070': '1x Bulbasaur Bind Down (Mega Evolution)',
    })
  })

  test('plusieurs cartes de plusieurs extensions en une demande : chacune sa ligne', async () => {
    await seed()
    await seedFrench()
    expect(await wants('464054,464070,464060,464073,464059')).toEqual({
      '464054': '1x Toxtricity VMAX G-Max Riot (V.2) (Rebellion Crash)',
      '464070': '1x Bulbasaur Bind Down (Mega Evolution)',
      '464060': null,
      '464073': '1x Bulbasaur Bind Down (Mega Brave)',
      '464059': '1x Toxtricity VMAX G-Max Riot (V.1) (Rebellion Crash)',
    })
  })
})

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
