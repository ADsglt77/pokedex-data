/**
 * Le catalogue (`worker/ingest/catalog.ts`), tiré de la base de l'importateur (TCGdex) : chaque
 * colonne d'une ligne à sa place (`CatalogRow` : l'id Cardmarket d'une autre version, et c'est le
 * mauvais prix, le mauvais lien) ; le type d'une carte dans les deux langues (TCGdex écrit le
 * français pour les françaises, l'anglais pour les japonaises) ; la rareté en français et à son
 * rang ; l'image et le logo seulement s'ils sont copiés, et de la langue de la carte ; les cartes
 * de Pokémon TCG Pocket et celles que TCGdex ne liste plus, écartées ; une carte japonaise dont le
 * détail n'est pas encore lu, gardée dans sa série ; les deux langues jamais mêlées (le même id de
 * série dans chacune) ; l'ordre des cartes ; le miroir que lit la tâche `prices` ; et la garde
 * contre une base de l'importateur vidée : rien d'écrit, la tâche échoue après l'autre langue.
 */

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { RARITIES, UNKNOWN_RARITY_RANK } from '@/config/catalog'
import type {
  CardLanguage,
  CatalogFile,
  CatalogSetFile,
  CatalogSetRow,
  CatalogSetsFile,
} from '@/contract'
import type { Step } from '../ingest/workflow'
import { alive, emptyCatalog, emptyFiles, rows, runCards } from './helpers'

// Les réponses des seuls Pokémon que lisent les tests, pas les 1 025 ; `catalog.ts`, déjà chargé
// par l'entrée du Worker, rechargé pour prendre cette liste.
vi.mock(import('@/config/pokedex'), async (original) => ({
  ...(await original()),
  SPECIES_IDS: [6, 25, 357],
}))
vi.resetModules()
const { catalog, saveLanguage } = await import('../ingest/catalog')

/** Une série de TCGdex (`series`) dans la base de l'importateur. */
const series = (lang: CardLanguage, id: string, name: string) =>
  runCards([
    'INSERT INTO series (id, tcgdex_id, language, name) VALUES (?, ?, ?, ?)',
    `${lang}:${id}`,
    id,
    lang,
    name,
  ])

/** Une extension (`sets`) : sa série, sa sortie, son nombre officiel de cartes, son logo copié. */
const set = (
  lang: CardLanguage,
  id: string,
  {
    serie = null,
    name = `Série ${id}`,
    released = '2023-09-22',
    official = 165,
    logo = null,
  }: {
    serie?: string | null
    name?: string
    released?: string | null
    official?: number | null
    logo?: string | null
  } = {},
) =>
  runCards([
    `INSERT INTO sets (id, tcgdex_id, series_id, language, name, release_date, official_cards,
                       logo_status, logo_r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `${lang}:${id}`,
    id,
    serie && `${lang}:${serie}`,
    lang,
    name,
    released,
    official,
    logo ? 'downloaded' : null,
    logo,
  ])

/** Une carte : son extension, son numéro, et ce que l'importateur en a (son détail : `detail`). */
interface Card {
  name?: string
  rarity?: string | null
  category?: string | null
  illustrator?: string | null
  image?: string | null
  status?: string
  detail?: Record<string, unknown>
  removed?: string | null
}

const card = (lang: CardLanguage, setId: string, number: string, fields: Card = {}) => {
  const id = `${setId}-${number}`
  const {
    name = `Carte ${id}`,
    rarity = null,
    category = null,
    illustrator = null,
    image = `cards/${lang}/${setId}/${id}.webp`,
    status = 'downloaded',
    detail = {},
    removed = null,
  } = fields
  return runCards([
    `INSERT INTO cards (id, tcgdex_id, language, name, local_id, set_id, rarity, category,
                        illustrator, image_r2_key, image_status, metadata_json, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `${lang}:${id}`,
    id,
    lang,
    name,
    number,
    `${lang}:${setId}`,
    rarity,
    category,
    illustrator,
    image,
    status,
    JSON.stringify(detail),
    removed,
  ])
}

/** Un Pokémon de ce type (`types[0]` de TCGdex), de ces numéros du Pokédex, de ces versions. */
const pokemon = (type: string, dexId: number[], variants: unknown[] = []): Card => ({
  category: 'Pokémon',
  detail: { dexId, types: [type], variants_detailed: variants },
})

/** Une version de TCGdex et son id Cardmarket. */
const variant = (type: string, cardmarket?: unknown, stamp?: string[]) => ({
  type,
  ...(cardmarket === undefined ? {} : { thirdParty: { cardmarket } }),
  ...(stamp ? { stamp } : {}),
})

/** Une réponse enregistrée ; `null` si elle n'existe pas. */
async function snapshot<T>(name: string) {
  const object = await env.FILES.get(`snapshots/${name}.json`)
  return object && (await object.json<T>())
}

const setFile = (name: string) => snapshot<CatalogSetFile>(name)
const speciesFile = (name: string) => snapshot<CatalogFile>(name)

/** Chaque langue : ses réponses et son miroir ; la raison d'un refus, `null` sinon. */
const save = async (lang: CardLanguage) => (await saveLanguage(lang, alive)).refused

/** Le stockage partagé entre les tests du fichier : chacun part d'un catalogue vide. */
beforeEach(async () => {
  await emptyCatalog()
  await emptyFiles()
})

describe('une carte, d’après TCGdex', () => {
  test('chaque colonne à sa place : numéro, numéro imprimé, id Cardmarket de la version normale, nom, image, rareté, type, versions', async () => {
    await series('fr', 'sv', 'Écarlate et Violet')
    await set('fr', 'sv03.5', { serie: 'sv', name: '151', official: 165 })
    // La version normale en second : c'est son id Cardmarket, pas celui de la première.
    await card('fr', 'sv03.5', '006', {
      name: 'Dracaufeu-ex',
      rarity: 'Double rare',
      illustrator: 'PLANETA Mochizuki',
      ...pokemon('Feu', [6], [variant('Reverse', 733602), variant('Normal', 733601)]),
    })
    expect(await save('fr')).toBeNull()
    const row: CatalogSetRow = {
      number: '006',
      printed: '006/165',
      name: 'Dracaufeu-ex',
      dexIds: [6],
      cardmarket: 733601,
      image: 'fr/sv03.5/sv03.5-006',
      rarity: 'Double rare',
      type: 'fire',
      illustrator: 'PLANETA Mochizuki',
      versions: ['Reverse', 'Normale'],
    }
    const rarities = { 'Double rare': RARITIES.get('Double rare')! }
    expect(await setFile('catalog/fr/sets/sv03.5')).toEqual({ cards: [row], rarities })
    expect(await speciesFile('catalog/fr/species/6')).toEqual({
      sets: { 'sv03.5': ['151', '2023-09-22', ''] },
      cards: {
        '6': [
          ['sv03.5', '006', 733601, 'Dracaufeu-ex', 'fr/sv03.5/sv03.5-006', 'Double rare', 'fire'],
        ],
      },
      rarities,
    })
    // Un Pokémon sans carte a sa réponse, vide.
    expect(await speciesFile('catalog/fr/species/25')).toEqual({
      sets: {},
      cards: {},
      rarities: {},
    })
  })

  test('l’id Cardmarket : celui de la version normale sans tampon, sinon d’une normale, sinon le premier qui en a un, sinon 0 ; jamais un id mal formé', async () => {
    await set('fr', 'base1', { official: 102 })
    // Carapuce sv03.5-007 : sa version tamponnée « Pokémon Center » est un autre produit.
    await card(
      'fr',
      'base1',
      '5',
      pokemon(
        'Eau',
        [7],
        [
          variant('Reverse', 794910),
          variant('Normal', 721198, ['Pokémon Center']),
          variant('Normal', 733602),
        ],
      ),
    )
    await card(
      'fr',
      'base1',
      '6',
      pokemon('Eau', [7], [variant('Holo', 1), variant('Normal', 721198, ['Pokémon Center'])]),
    )
    await card(
      'fr',
      'base1',
      '1',
      pokemon('Eau', [9], [variant('Holo', 273699), variant('normal')]),
    )
    await card('fr', 'base1', '2', pokemon('Eau', [9], [variant('Holo'), variant('Reverse', 5)]))
    await card(
      'fr',
      'base1',
      '3',
      pokemon('Eau', [9], [variant('Normal', '12'), variant('Holo', -4)]),
    )
    await card('fr', 'base1', '4', pokemon('Eau', [9]))
    await save('fr')
    const cards = (await setFile('catalog/fr/sets/base1'))!.cards
    expect(cards.map(({ number, cardmarket }) => [number, cardmarket])).toEqual([
      ['1', 273699],
      ['2', 5],
      ['3', 0],
      ['4', 0],
      ['5', 733602],
      ['6', 721198],
    ])
  })

  test('le type, dans les deux langues : l’énergie d’un Pokémon, la catégorie d’un dresseur ou d’une énergie ; inconnu sans détail', async () => {
    await set('fr', 'swsh1')
    await set('ja', 'SV1a')
    const fr: [string, Card][] = [
      ['1', pokemon('Électrique', [25])],
      ['2', pokemon('Incolore', [25])],
      ['3', { category: 'Dresseur', detail: { trainerType: 'Objet' } }],
      ['4', { category: 'Dresseur', detail: { trainerType: 'Supporter' } }],
      ['5', { category: 'Dresseur', detail: { trainerType: 'Stade' } }],
      ['6', { category: 'Dresseur', detail: { trainerType: 'Outil' } }],
      ['7', { category: 'Dresseur', detail: { trainerType: 'Machine Technique' } }],
      ['8', { category: 'Dresseur', detail: {} }],
      ['9', { category: 'Énergie', detail: { energyType: 'De base' } }],
      ['10', { category: 'Énergie', detail: { energyType: 'Spécial' } }],
      ['11', { category: 'Énergie', detail: {} }],
      ['12', {}],
    ]
    const ja: [string, Card][] = [
      ['001', { category: 'Pokemon', detail: { dexId: [357], types: ['Grass'] } }],
      ['002', { category: 'Pokemon', detail: { dexId: [25], types: ['Lightning'] } }],
      ['003', { category: 'Trainer', detail: { trainerType: 'Item' } }],
      ['004', { category: 'Trainer', detail: { trainerType: 'Stadium' } }],
      ['005', { category: 'Energy', detail: { energyType: 'Special' } }],
      ['006', { category: 'Pokemon', detail: { dexId: [25], types: ['Inconnu'] } }],
    ]
    for (const [number, fields] of fr) await card('fr', 'swsh1', number, fields)
    for (const [number, fields] of ja) await card('ja', 'SV1a', number, fields)
    await save('fr')
    await save('ja')
    const types = async (name: string) => (await setFile(name))!.cards.map(({ type }) => type)
    expect(await types('catalog/fr/sets/swsh1')).toEqual([
      'lightning',
      'colorless',
      'item',
      'supporter',
      'stadium',
      'tool',
      'technical-machine',
      'trainer',
      'basic-energy',
      'special-energy',
      'energy',
      '',
    ])
    expect(await types('catalog/sets/SV1a')).toEqual([
      'grass',
      'lightning',
      'item',
      'stadium',
      'special-energy',
      '',
    ])
  })

  test('la rareté : son nom en français et son rang, de la plus commune à la plus rare ; une inconnue après toutes', async () => {
    await set('ja', 'SV2a')
    const written = ['Common', 'Art Rare', 'Special Art Rare', 'Couronne de neige']
    for (const [index, rarity] of written.entries()) {
      await card('ja', 'SV2a', `00${index + 1}`, { rarity, ...pokemon('Fire', [6]) })
    }
    await save('ja')
    const { rarities } = (await setFile('catalog/sets/SV2a'))!
    expect(Object.keys(rarities)).toEqual(written)
    expect(rarities['Common']![0]).toBe('Commune')
    expect(rarities['Art Rare']![0]).toBe('Illustration rare')
    expect(rarities['Special Art Rare']![0]).toBe('Illustration spéciale rare')
    expect(rarities['Couronne de neige']).toEqual(['Couronne de neige', UNKNOWN_RARITY_RANK])
    const rank = (rarity: string) => rarities[rarity]![1]
    expect(rank('Common')).toBeLessThan(rank('Art Rare'))
    expect(rank('Art Rare')).toBeLessThan(rank('Special Art Rare'))
    expect(rank('Special Art Rare')).toBeLessThan(rank('Couronne de neige'))
    // Les mêmes raretés écrites en français : les mêmes noms, les mêmes rangs.
    expect(RARITIES.get('Commune')).toEqual(RARITIES.get('Common'))
    expect(RARITIES.get('Illustration spéciale rare')).toEqual(RARITIES.get('Special Art Rare'))
    // Ce que TCGdex appelle « Magnifique rare » : les rares secrètes.
    expect(RARITIES.get('Magnifique rare')![0]).toBe('Rare secrète')
  })

  test('les versions en français, la première édition d’après son tampon ; sans versions détaillées, d’après les drapeaux', async () => {
    await set('fr', 'base1', { official: 102 })
    await card('fr', 'base1', '4', {
      ...pokemon(
        'Feu',
        [6],
        [
          variant('Holo', 273699),
          variant('Holo', 660224, ['1re Édition']),
          variant('Holo', 660224),
        ],
      ),
    })
    await card('fr', 'base1', '5', {
      category: 'Pokémon',
      detail: { dexId: [6], variants: { normal: true, reverse: true, holo: false } },
    })
    await save('fr')
    const cards = (await setFile('catalog/fr/sets/base1'))!.cards
    expect(cards.map(({ versions }) => versions)).toEqual([
      ['Holo', '1re édition'],
      ['Normale', 'Reverse'],
    ])
  })

  test('l’image et le logo, seulement copiés et de la langue de la carte : sinon aucun', async () => {
    await set('fr', 'sv01', { logo: 'cards/fr/sv01/_logo.webp' })
    await set('fr', 'sv02', { logo: null })
    // Le logo d'une autre langue : jamais.
    await set('fr', 'sv03', { logo: 'cards/ja/sv03/_logo.webp' })
    await card('fr', 'sv01', '001')
    await card('fr', 'sv01', '002', { status: 'not_found_on_cdn', image: null })
    await card('fr', 'sv01', '003', { status: 'recovered_from_cdn' })
    await card('fr', 'sv01', '004', { status: 'download_error' })
    await card('fr', 'sv01', '005', { image: 'cards/ja/sv01/sv01-005.webp' })
    await card('fr', 'sv01', '006', { image: 'cards/fr/sv01/../sv01-006.webp' })
    await card('fr', 'sv02', '001')
    await card('fr', 'sv03', '001')
    await save('fr')
    const cards = (await setFile('catalog/fr/sets/sv01'))!.cards
    expect(cards.map(({ image }) => image)).toEqual([
      'fr/sv01/sv01-001',
      '',
      'fr/sv01/sv01-003',
      '',
      '',
      '',
    ])
    const { sets } = (await snapshot<CatalogSetsFile>('catalog/fr/sets'))!
    expect(sets.map(([id, , , logo]) => [id, logo])).toEqual([
      ['sv01', 'fr/sv01'],
      ['sv02', ''],
      ['sv03', ''],
    ])
  })

  test('une carte japonaise dont le détail n’est pas encore lu : dans sa série, sans Pokémon, type, rareté ni id Cardmarket', async () => {
    await set('ja', 'S11a', { official: 68 })
    await card('ja', 'S11a', '001', { name: 'ストライク' })
    await save('ja')
    expect((await setFile('catalog/sets/S11a'))!.cards).toEqual([
      {
        number: '001',
        printed: '001/068',
        name: 'ストライク',
        dexIds: [],
        cardmarket: 0,
        image: 'ja/S11a/S11a-001',
        rarity: '',
        type: '',
        illustrator: '',
        versions: [],
      },
    ])
  })
})

describe('les séries et les cartes retenues', () => {
  test('ni les séries de Pokémon TCG Pocket, ni les cartes que TCGdex ne liste plus ; une série sans carte n’a pas de réponse', async () => {
    await series('fr', 'tcgp', 'Jeu de Cartes à Collectionner Pokémon Pocket')
    await series('fr', 'sv', 'Écarlate et Violet')
    await set('fr', 'A1', { serie: 'tcgp' })
    await set('fr', 'sv01', { serie: 'sv' })
    await set('fr', 'sv02', { serie: 'sv' })
    await card('fr', 'A1', '001', pokemon('Électrique', [25]))
    await card('fr', 'sv01', '001', pokemon('Électrique', [25]))
    await card('fr', 'sv01', '002', { ...pokemon('Électrique', [25]), removed: '2026-11-01' })
    await card('fr', 'sv02', '001', { removed: '2026-11-01' })
    await save('fr')
    const { sets } = (await snapshot<CatalogSetsFile>('catalog/fr/sets'))!
    expect(sets.map(([id, , , , cards]) => [id, cards])).toEqual([['sv01', 1]])
    expect(await setFile('catalog/fr/sets/A1')).toBeNull()
    expect(await setFile('catalog/fr/sets/sv02')).toBeNull()
    expect(
      (await speciesFile('catalog/fr/species/25'))!.cards['25']!.map(([, number]) => number),
    ).toEqual(['001'])
    expect(await rows("SELECT set_id, number FROM catalog_cards WHERE lang = 'fr'")).toEqual([
      { set_id: 'sv01', number: '001' },
    ])
  })

  test('une série qui n’a plus de cartes : sa réponse retirée, dans sa langue seulement', async () => {
    for (const lang of ['ja', 'fr'] as const) {
      await set(lang, 'P')
      await card(lang, 'P', '001')
      await set(lang, 'Q')
      await card(lang, 'Q', '001')
      await save(lang)
    }
    await runCards("UPDATE cards SET removed_at = '2026-11-12' WHERE id = 'fr:P-001'")
    await save('fr')
    expect(await setFile('catalog/fr/sets/P')).toBeNull()
    expect(await setFile('catalog/fr/sets/Q')).not.toBeNull()
    expect(await setFile('catalog/sets/P')).not.toBeNull()
  })

  test('le même id de série dans les deux langues : chaque langue ses réponses et son miroir', async () => {
    await set('ja', 'P', { name: 'Promos japonaises', released: '2023-01-01' })
    await set('fr', 'P', { name: 'Promos françaises', released: '2023-03-31' })
    await card('ja', 'P', '001', {
      name: 'ピカチュウ',
      ...pokemon('Lightning', [25], [variant('normal', 111)]),
    })
    await card('fr', 'P', '001', {
      name: 'Pikachu',
      ...pokemon('Électrique', [25], [variant('Normal', 222)]),
    })
    await save('ja')
    await save('fr')
    expect((await setFile('catalog/sets/P'))!.cards[0]).toMatchObject({
      name: 'ピカチュウ',
      cardmarket: 111,
      image: 'ja/P/P-001',
      type: 'lightning',
    })
    expect((await setFile('catalog/fr/sets/P'))!.cards[0]).toMatchObject({
      name: 'Pikachu',
      cardmarket: 222,
      image: 'fr/P/P-001',
      type: 'lightning',
    })
    expect((await speciesFile('catalog/species/25'))!.sets).toEqual({
      P: ['Promos japonaises', '2023-01-01', ''],
    })
    expect((await speciesFile('catalog/fr/species/25'))!.sets).toEqual({
      P: ['Promos françaises', '2023-03-31', ''],
    })
    expect(
      await rows(
        'SELECT lang, set_id, number, cardmarket, released FROM catalog_cards ORDER BY lang',
      ),
    ).toEqual([
      { lang: 'fr', set_id: 'P', number: '001', cardmarket: 222, released: '2023-03-31' },
      { lang: 'ja', set_id: 'P', number: '001', cardmarket: 111, released: '2023-01-01' },
    ])
  })

  test('les séries des plus récentes aux plus anciennes, leurs blocs ; la sortie en YYYY-MM-DD ; un id que les routes ne servent pas, écarté', async () => {
    await series('ja', 'SV', 'スカーレット&バイオレット')
    await series('ja', 'S', '剣と盾')
    await set('ja', 'S12a', { serie: 'S', released: '2022-12-02' })
    await set('ja', 'SV1a', { serie: 'SV', released: '2023-03-10T00:00:00Z' })
    await set('ja', 'SM1+', { released: 'bientôt' })
    await set('ja', 'a b', { serie: 'SV', released: '2024-01-01' })
    for (const id of ['S12a', 'SV1a', 'SM1+', 'a b']) await card('ja', id, '001')
    await save('ja')
    expect(await snapshot<CatalogSetsFile>('catalog/sets')).toEqual({
      blocks: ['スカーレット&バイオレット', '剣と盾'],
      sets: [
        ['SV1a', 'Série SV1a', '2023-03-10', '', 1, 0],
        ['S12a', 'Série S12a', '2022-12-02', '', 1, 1],
        ['SM1+', 'Série SM1+', '', '', 1, -1],
      ],
    })
    expect(await setFile('catalog/sets/SM1+')).not.toBeNull()
  })

  test('l’ordre des cartes : par leur nombre, puis celles sans nombre en tête ; dans la fenêtre d’ajout, des plus récentes aux plus anciennes', async () => {
    await set('fr', 'old', { released: '2020-01-01', official: 0 })
    await set('fr', 'new', { released: '2024-01-01', official: 165 })
    for (const number of ['TG10', '10', 'TG2', '2', '1']) {
      await card('fr', 'new', number, pokemon('Feu', [6]))
    }
    await card('fr', 'old', '7', pokemon('Feu', [6]))
    await save('fr')
    const ordered = (await setFile('catalog/fr/sets/new'))!.cards
    expect(ordered.map(({ number, printed }) => [number, printed])).toEqual([
      ['1', '1/165'],
      ['2', '2/165'],
      ['10', '10/165'],
      ['TG2', 'TG2'],
      ['TG10', 'TG10'],
    ])
    // Sans nombre officiel de cartes : le numéro seul.
    expect((await setFile('catalog/fr/sets/old'))!.cards[0]!.printed).toBe('7')
    const species = (await speciesFile('catalog/fr/species/6'))!.cards['6']!
    expect(species.map(([set, number]) => `${set} ${number}`)).toEqual([
      'new TG10',
      'new TG2',
      'new 10',
      'new 2',
      'new 1',
      'old 7',
    ])
  })

  test('une carte de plusieurs Pokémon : dans la fenêtre d’ajout de chacun, avec ses Pokémon', async () => {
    await set('fr', 'sm9')
    await card('fr', 'sm9', '001', pokemon('Feu', [6, 25, 9999, 25]))
    await save('fr')
    const rows25 = (await speciesFile('catalog/fr/species/25'))!.cards['25']!
    // Un numéro hors du Pokédex écarté, un numéro répété compté une fois.
    expect(rows25).toHaveLength(1)
    const row = rows25[0]!
    expect(row[7]).toEqual([6, 25])
    expect((await speciesFile('catalog/fr/species/6'))!.cards['6']![0]).toEqual(row)
  })
})

describe('la garde et le passage', () => {
  test('une base de l’importateur vide, ou qui a perdu plus de la moitié des cartes du miroir : rien n’est écrit', async () => {
    expect(await save('fr')).toContain('Cartes françaises : 0, contre 0')
    await set('fr', 'sv01')
    for (const number of ['1', '2', '3', '4', '5']) await card('fr', 'sv01', number)
    expect(await save('fr')).toBeNull()
    const before = await setFile('catalog/fr/sets/sv01')
    await runCards("UPDATE cards SET removed_at = '2026-11-12' WHERE local_id IN ('1', '2', '3')")
    expect(await save('fr')).toContain('Cartes françaises : 2, contre 5')
    expect(await setFile('catalog/fr/sets/sv01')).toEqual(before)
    expect(await rows("SELECT COUNT(*) AS count FROM catalog_cards WHERE lang = 'fr'")).toEqual([
      { count: 5 },
    ])
  })

  test('une langue refusée : l’autre est enregistrée, puis la tâche échoue', async () => {
    await set('fr', 'sv01')
    await card('fr', 'sv01', '1')
    const step: Step = (_name, work) => work(alive)
    await expect(catalog(step)).rejects.toThrow('Cartes japonaises : 0, contre 0')
    expect(await setFile('catalog/fr/sets/sv01')).not.toBeNull()
    expect(await snapshot('catalog/sets')).toBeNull()
  })

  test('le miroir suit le catalogue : une carte changée réécrite, une carte retirée retirée', async () => {
    await set('fr', 'sv01', { released: '2026-11-01' })
    await card('fr', 'sv01', '1', pokemon('Feu', [6], [variant('Normal', 10)]))
    await card('fr', 'sv01', '2', pokemon('Feu', [6], [variant('Normal', 20)]))
    await save('fr')
    await runCards(
      "UPDATE cards SET removed_at = '2026-11-12' WHERE local_id = '1'",
      `UPDATE cards SET metadata_json = '{"variants_detailed":[{"type":"Normal","thirdParty":{"cardmarket":21}}]}'
       WHERE local_id = '2'`,
    )
    await save('fr')
    expect(await rows('SELECT set_id, number, cardmarket, released FROM catalog_cards')).toEqual([
      { set_id: 'sv01', number: '2', cardmarket: 21, released: '2026-11-01' },
    ])
  })
})
