/**
 * Le catalogue dans deux langues (`worker/ingest/catalog.ts`) : chez Pokécardex, les ids des
 * cartes, les codes des séries et les ids des raretés se répètent d'une zone à l'autre (la carte
 * 7091 : Regirock de SM4A au Japon, Alakazam du Set de base en France). Une carte d'une langue ne
 * doit jamais écraser ni retirer celle de l'autre, ni une réponse d'une langue montrer l'autre ;
 * chaque colonne d'une ligne du catalogue à sa place (`CatalogRow`, des nombres sans noms : l'une
 * prise pour une autre donnerait à une carte l'id Cardmarket d'une autre, mauvais prix, mauvais
 * lien) ; une carte qui n'existe qu'en anglais n'entre pas au catalogue français ; le nom
 * d'extension Cardmarket d'une série (la liste de souhaits) : jamais un nom que ses cartes ne
 * confirment pas, et un nom anglais qu'elles ne confirment pas n'efface pas celui qu'elles
 * confirment encore ; l'extension de ses adresses, gardée même sans nom (sans elle, la liste de
 * souhaits ne verrait pas qu'un nom désigne aussi son extension) ; une série renumérotée par la
 * source : la tâche compte les cartes déjà copiées qui changent de rang (ou de série), pour que le
 * journal le dise, et elles sont à chercher de nouveau. Et les garde-fous contre une erreur de la
 * source : un menu qui retire plus de 3 séries connues, ou l'une de plus de 20 cartes, n'efface
 * rien ; une carte dont l'id ou le rang ne sont pas des entiers positifs est écartée, et la
 * lecture ne retire alors rien ; un id Cardmarket mal formé compte pour aucun.
 */

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PokecardexCard, PokecardexSeries } from '../ingest/pokecardex'
import { emptyCatalog, emptyFiles, rows } from './helpers'

// `saveLanguage` pour les seuls Pokémon que lisent les tests, pas les 1 025 ; `catalog.ts`, déjà
// chargé par l'entrée du Worker, rechargé pour prendre cette liste.
vi.mock(import('@/config/pokedex'), async (original) => ({
  ...(await original()),
  SPECIES_IDS: [65, 377],
}))
vi.resetModules()
const { saveBlocks, saveLanguage, saveSeries } = await import('../ingest/catalog')

const READ_AT = '2026-10-22T10:00:00.000Z'
const LATER = '2026-10-29T10:00:00.000Z'

/** Une carte d'une page, telle que la donne Pokécardex. */
const card = (
  fields: Partial<PokecardexCard> & { id_card: number; sort: number },
): PokecardexCard => ({
  num_card: `${String(fields.sort).padStart(3, '0')}/100`,
  name_card_fr: 'Carte',
  name_card_en: 'Card',
  name_card_de: 'Karte',
  id_pokedex_list: [],
  id_cardmarket: null,
  cardmarket_url: null,
  only_english: 0,
  id_rarete: 48,
  id_type: 1,
  nom_illustrateur: 'Illustrateur',
  versions: [{ nom_version: 'Standard' }],
  ...fields,
})

/** Une série : son code, son nom, sa zone du menu et son bloc. */
interface Series {
  code: string
  fullName: string
  region: 'JP' | 'FR'
  block: string
}

/** La page d'une série et son menu (son seul bloc). */
const page = (
  { code, fullName, region, block }: Series,
  cartes: PokecardexCard[],
): PokecardexSeries => ({
  currentSeries: { fullName, releaseDateFR: '2023-06-16 00:00:00' },
  cartes,
  seriesMenu: {
    blocksByRegion: {
      [region]: [{ name: block, nameUS: block, series: [{ shortName: code, fullName }] }],
    },
  },
})

const JAPANESE: Series = {
  code: 'SVP',
  fullName: 'SV-P Promo',
  region: 'JP',
  block: 'Scarlet & Violet',
}
const FRENCH: Series = {
  code: 'SVP',
  fullName: 'Promos Écarlate et Violet',
  region: 'FR',
  block: 'Écarlate et Violet',
}
/**
 * La carte 7091 des deux zones : Regirock au Japon, Alakazam en France ; leurs nombres tous
 * différents (id Cardmarket, rang, rareté, type), qu'une colonne prise pour une autre se voie.
 */
const REGIROCK = card({
  id_card: 7091,
  sort: 1,
  name_card_fr: 'Regirock',
  id_pokedex_list: [377],
  id_cardmarket: 712345,
  id_type: 7,
})
const ALAKAZAM = card({
  id_card: 7091,
  sort: 1,
  name_card_fr: 'Alakazam',
  id_pokedex_list: [65],
  id_cardmarket: 274123,
  id_type: 5,
})

/** Le stockage partagé entre les tests d'un fichier : chacun part d'un catalogue vide. */
beforeEach(async () => {
  await emptyCatalog()
  await emptyFiles()
})

/** Une réponse enregistrée ; `null` si elle n'existe pas. */
async function snapshot(name: string) {
  const object = await env.FILES.get(`snapshots/${name}.json`)
  return object && (await object.json<Record<string, unknown>>())
}

const cards = () =>
  rows(
    `SELECT lang, id, set_id AS 'set', name,
            (SELECT json_group_array(dex_id) FROM card_species
             WHERE card_species.lang = cards.lang AND card = cards.id) AS dexIds
     FROM cards ORDER BY lang, id`,
  )

/** Le nom d'extension Cardmarket d'une série. */
const expansion = async (lang: string, code: string) =>
  (await env.DB.prepare('SELECT expansion_name AS name FROM sets WHERE lang = ? AND id = ?')
    .bind(lang, code)
    .first<{ name: string }>())!.name

describe('saveSeries', () => {
  test('une série et une carte françaises au même code et au même id que des japonaises coexistent', async () => {
    await saveSeries('ja', 'SVP', page(JAPANESE, [REGIROCK]), READ_AT, null)
    await saveSeries('fr', 'SVP', page(FRENCH, [ALAKAZAM]), READ_AT, null)
    expect(await cards()).toEqual([
      { lang: 'fr', id: 7091, set: 'SVP', name: 'Alakazam', dexIds: '[65]' },
      { lang: 'ja', id: 7091, set: 'SVP', name: 'Regirock', dexIds: '[377]' },
    ])
    expect(await rows('SELECT lang, id, name FROM sets ORDER BY lang')).toEqual([
      { lang: 'fr', id: 'SVP', name: 'Promos Écarlate et Violet' },
      { lang: 'ja', id: 'SVP', name: 'SV-P Promo' },
    ])

    // La série japonaise relue sans la carte 7091 : seule la japonaise est retirée.
    const other = card({ id_card: 7092, sort: 2, name_card_fr: 'Regice', id_pokedex_list: [378] })
    await saveSeries('ja', 'SVP', page(JAPANESE, [other]), LATER, null)
    expect(await cards()).toEqual([
      { lang: 'fr', id: 7091, set: 'SVP', name: 'Alakazam', dexIds: '[65]' },
      { lang: 'ja', id: 7092, set: 'SVP', name: 'Regice', dexIds: '[378]' },
    ])
  })

  test('une carte only_english n’entre pas au catalogue français', async () => {
    const english = card({ id_card: 7092, sort: 2, name_card_fr: 'Shadowless', only_english: 1 })
    await saveSeries('fr', 'SVP', page(FRENCH, [ALAKAZAM, english]), READ_AT, null)
    expect(await cards()).toEqual([
      { lang: 'fr', id: 7091, set: 'SVP', name: 'Alakazam', dexIds: '[65]' },
    ])
  })

  test('le nom d’extension Cardmarket : celui d’une japonaise, d’une française son nom anglais confirmé par ses cartes', async () => {
    const meg = (code: string) => ({ ...FRENCH, code, fullName: 'Méga-Évolution' })
    const bulbizarre = card({
      id_card: 1,
      sort: 1,
      cardmarket_url: 'Mega-Evolution/Bulbasaur-V1-MEG001',
    })
    await saveSeries('ja', 'SVP', page(JAPANESE, [REGIROCK]), READ_AT, null)
    await saveSeries('fr', 'MEG', page(meg('MEG'), [bulbizarre]), READ_AT, 'Mega Evolution')
    const second = page(meg('PFL'), [{ ...bulbizarre, id_card: 2 }])
    await saveSeries('fr', 'PFL', second, READ_AT, 'Phantasmal Flames')
    await saveSeries('fr', 'ASC', page(meg('ASC'), [{ ...bulbizarre, id_card: 3 }]), READ_AT, null)
    expect(await expansion('ja', 'SVP')).toBe('SV-P Promo')
    expect(await expansion('fr', 'MEG')).toBe('Mega Evolution')
    // Un nom que les adresses de ses cartes ne confirment pas, ou aucun nom : aucun.
    expect(await expansion('fr', 'PFL')).toBe('')
    expect(await expansion('fr', 'ASC')).toBe('')
    // Le nom écrit comme dans une adresse, et l'extension des adresses des cartes, gardée même
    // sans nom : la liste de souhaits les compare (`readWants`).
    expect(
      await rows(
        `SELECT lang, id, expansion_slug AS name, cardmarket_slug AS cards FROM sets
         ORDER BY lang, id`,
      ),
    ).toEqual([
      { lang: 'fr', id: 'ASC', name: '', cards: 'Mega-Evolution' },
      { lang: 'fr', id: 'MEG', name: 'Mega-Evolution', cards: 'Mega-Evolution' },
      { lang: 'fr', id: 'PFL', name: '', cards: 'Mega-Evolution' },
      { lang: 'ja', id: 'SVP', name: 'SV-P-Promo', cards: '' },
    ])
  })

  test('les noms anglais indisponibles, une française garde le nom déjà confirmé par ses cartes', async () => {
    const series = { ...FRENCH, code: 'MEG', fullName: 'Méga-Évolution' }
    const bulbizarre = (url: string) => card({ id_card: 1, sort: 1, cardmarket_url: url })
    const meg = page(series, [bulbizarre('Mega-Evolution/Bulbasaur-V1-MEG001')])
    await saveSeries('fr', 'MEG', meg, READ_AT, 'Mega Evolution')
    // Relue sans noms anglais (page anglaise illisible, ou la série absente de son menu).
    await saveSeries('fr', 'MEG', meg, LATER, null)
    expect(await expansion('fr', 'MEG')).toBe('Mega Evolution')
    // Ses cartes ne le confirment plus : aucun nom, avec ou sans nom anglais.
    const moved = page(series, [bulbizarre('Phantasmal-Flames/Bulbasaur-PFL001')])
    await saveSeries('fr', 'MEG', moved, LATER, null)
    expect(await expansion('fr', 'MEG')).toBe('')
    await saveSeries('fr', 'MEG', meg, LATER, 'Mega Evolution')
    await saveSeries('fr', 'MEG', moved, LATER, 'Mega Evolution')
    expect(await expansion('fr', 'MEG')).toBe('')
  })

  test('un nom anglais que ses cartes ne confirment pas : la française garde celui qu’elles confirment encore', async () => {
    const series = { ...FRENCH, code: 'MEG', fullName: 'Méga-Évolution' }
    const meg = page(series, [
      card({ id_card: 1, sort: 1, cardmarket_url: 'Mega-Evolution/Bulbasaur-V1-MEG001' }),
    ])
    await saveSeries('fr', 'MEG', meg, READ_AT, 'Mega Evolution')
    // La page anglaise répond, mais son menu donne un autre nom (celui d'une autre série, une
    // précision ajoutée) : ses cartes confirment toujours celui d'avant.
    await saveSeries('fr', 'MEG', meg, LATER, 'Phantasmal Flames')
    expect(await expansion('fr', 'MEG')).toBe('Mega Evolution')
    await saveSeries('fr', 'MEG', meg, LATER, 'Mega Evolution (Set)')
    expect(await expansion('fr', 'MEG')).toBe('Mega Evolution')
  })

  test('moins de la moitié des cartes d’avant (le format des pages a changé) : une erreur, rien d’écrit', async () => {
    const [un, deux, trois] = [1, 2, 3].map((id) => card({ id_card: id, sort: id }))
    await saveSeries('fr', 'SVP', page(FRENCH, [un!, deux!, trois!]), READ_AT, null)
    await expect(saveSeries('fr', 'SVP', page(FRENCH, [un!]), LATER, null)).rejects.toThrow(
      'format des pages changé',
    )
    expect(await cards()).toHaveLength(3)
  })
})

describe('une carte déjà copiée que la source renumérote', () => {
  test('saveSeries compte les cartes déjà copiées dont le rang ou la série change, et elles seules', async () => {
    const series = { ...FRENCH, code: 'MEG', fullName: 'Méga-Évolution' }
    const [un, deux, trois] = [1, 2, 3].map((id) => card({ id_card: id, sort: id }))
    const first = await saveSeries('fr', 'MEG', page(series, [un!, deux!, trois!]), READ_AT, null)
    expect(first.moved).toBe(0)
    // Les scans des cartes 1 et 2 sont copiés (la tâche `images`) ; celui de la 3 pas encore.
    await env.DB.prepare("UPDATE cards SET image = 'pokecardex' WHERE id IN (1, 2)").run()
    // Relue telle quelle : rien ne change.
    const same = await saveSeries('fr', 'MEG', page(series, [un!, deux!, trois!]), LATER, null)
    expect(same.moved).toBe(0)
    // Une carte arrive en tête : les trois passent au rang suivant, deux d'entre elles sont copiées.
    // Les trois d'avant sont comptées aussi (`known`).
    const shifted = [
      card({ id_card: 4, sort: 1 }),
      ...[un!, deux!, trois!].map((c) => ({ ...c, sort: c.sort + 1 })),
    ]
    expect(await saveSeries('fr', 'MEG', page(series, shifted), LATER, null)).toEqual({
      saved: 4,
      moved: 2,
      known: 3,
      rejected: 0,
    })
    // Elles sont à chercher de nouveau : leur rang a une autre image.
    const copied = () => rows("SELECT id FROM cards WHERE image = 'pokecardex'")
    expect(await copied()).toEqual([])
    // La carte 4, copiée, change de série au même rang : comptée, et à chercher de nouveau.
    await env.DB.prepare("UPDATE cards SET image = 'pokecardex' WHERE id = 4").run()
    const elsewhere = page({ ...series, code: 'MEG2' }, [card({ id_card: 4, sort: 1 })])
    expect((await saveSeries('fr', 'MEG2', elsewhere, LATER, null)).moved).toBe(1)
    expect(await copied()).toEqual([])
  })
})

describe('saveLanguage', () => {
  /** Les deux séries SVP, leurs blocs et leurs raretés, puis les réponses. */
  async function saveBoth() {
    await saveSeries('ja', 'SVP', page(JAPANESE, [REGIROCK]), READ_AT, null)
    await saveSeries('fr', 'SVP', page(FRENCH, [ALAKAZAM]), READ_AT, null)
    await env.DB.prepare(
      "INSERT INTO rarities (lang, id, name, rank) VALUES ('ja', 48, 'FUR', 1), ('fr', 48, 'Futuriste Rare', 1)",
    ).run()
    await saveBlocks('ja', [{ name: JAPANESE.block, series: ['SVP'], decks: [] }], [])
    await saveBlocks('fr', [{ name: FRENCH.block, series: ['SVP'], decks: [] }], [])
    await saveLanguage('ja')
    await saveLanguage('fr')
  }

  test('des réponses distinctes par langue', async () => {
    await saveBoth()
    expect(await snapshot('catalog/sets')).toEqual({
      blocks: ['Scarlet & Violet'],
      sets: [['SVP', 'SV-P Promo', '2023-06-16', 1, 1, 0, 0]],
    })
    expect(await snapshot('catalog/fr/sets')).toEqual({
      blocks: ['Écarlate et Violet'],
      sets: [['SVP', 'Promos Écarlate et Violet', '2023-06-16', 1, 1, 0, 0]],
    })
    expect(await snapshot('catalog/sets/SVP')).toMatchObject({
      cards: [{ name: 'Regirock', dexIds: [377] }],
      rarities: { 48: ['FUR', 1] },
    })
    expect(await snapshot('catalog/fr/sets/SVP')).toMatchObject({
      cards: [{ name: 'Alakazam', dexIds: [65] }],
      rarities: { 48: ['Futuriste Rare', 1] },
    })
    const species = async (name: string, dex: number) =>
      ((await snapshot(name))!.cards as Record<number, unknown[]>)[dex]
    // [série, numéro, id Cardmarket, nom, image (son rang), rareté, type] (`CatalogRow`).
    expect(await species('catalog/species/377', 377)).toEqual([
      ['SVP', '001', 712345, 'Regirock', 1, 48, 7],
    ])
    expect(await species('catalog/fr/species/65', 65)).toEqual([
      ['SVP', '001', 274123, 'Alakazam', 1, 48, 5],
    ])
    expect((await snapshot('catalog/species/65'))!.cards).toEqual({})
    expect((await snapshot('catalog/fr/species/377'))!.cards).toEqual({})
  })

  test('les réponses d’une série retirée ne sont retirées que dans sa langue', async () => {
    await saveBoth()
    const meg = page({ ...FRENCH, code: 'MEG' }, [card({ id_card: 1, sort: 1 })])
    await saveSeries('fr', 'MEG', meg, READ_AT, null)
    await saveBlocks('fr', [{ name: FRENCH.block, series: ['MEG'], decks: [] }], ['SVP'])
    await saveLanguage('fr')
    await saveLanguage('ja')
    expect(await snapshot('catalog/fr/sets/SVP')).toBeNull()
    expect(await snapshot('catalog/fr/sets/MEG')).not.toBeNull()
    expect(await snapshot('catalog/sets/SVP')).not.toBeNull()
    // La série japonaise et sa carte restent.
    expect(await rows("SELECT lang FROM sets WHERE id = 'SVP'")).toEqual([{ lang: 'ja' }])
    expect(await cards()).toEqual([
      { lang: 'fr', id: 1, set: 'MEG', name: 'Carte', dexIds: '[]' },
      { lang: 'ja', id: 7091, set: 'SVP', name: 'Regirock', dexIds: '[377]' },
    ])
  })

  test('une langue sans cartes : aucune réponse (l’API répond 404)', async () => {
    await saveSeries('ja', 'SVP', page(JAPANESE, [REGIROCK]), READ_AT, null)
    await saveLanguage('ja')
    await saveLanguage('fr')
    expect(await snapshot('catalog/sets')).not.toBeNull()
    expect(await snapshot('catalog/fr/sets')).toBeNull()
    expect(await snapshot('catalog/fr/species/65')).toBeNull()
  })
})

describe('les garde-fous des écritures du catalogue', () => {
  /** Une série de `count` cartes, enregistrée (ids `base + 1` à `base + count`). */
  const known = (code: string, count: number, base: number, lang: 'ja' | 'fr' = 'ja') =>
    saveSeries(
      lang,
      code,
      page(
        { ...(lang === 'ja' ? JAPANESE : FRENCH), code },
        Array.from({ length: count }, (_, index) =>
          card({ id_card: base + index + 1, sort: index + 1 }),
        ),
      ),
      READ_AT,
      null,
    )
  const setCodes = async () =>
    (await rows("SELECT id FROM sets WHERE lang = 'ja' ORDER BY id")).map(({ id }) => id)
  const blocks = [{ name: JAPANESE.block, series: ['A'], decks: [] }]

  test('le menu range en « Asia Exclusive » une série connue de plus de 20 cartes : refusé, rien d’effacé, les blocs écrits', async () => {
    await known('A', 1, 0)
    await known('BIG', 21, 100)
    expect(await saveBlocks('ja', blocks, ['BIG'])).toContain('BIG (21 cartes)')
    expect(await setCodes()).toEqual(['A', 'BIG'])
    expect((await cards()).length).toBe(22)
    expect(await rows("SELECT block FROM sets WHERE id = 'A'")).toEqual([{ block: JAPANESE.block }])
    // Le même retrait d'une série de 20 cartes : accepté.
    await known('MID', 20, 200)
    expect(await saveBlocks('ja', blocks, ['MID'])).toBeNull()
    expect(await setCodes()).toEqual(['A', 'BIG'])
  })

  test('les séries et les cartes comptées sont celles de la langue : une française de même code n’empêche rien', async () => {
    await known('SMALL', 1, 0)
    await known('SMALL', 25, 100, 'fr')
    expect(await saveBlocks('ja', blocks, ['SMALL'])).toBeNull()
    expect(await rows("SELECT lang FROM sets WHERE id = 'SMALL'")).toEqual([{ lang: 'fr' }])
  })

  test('plus de 3 séries connues à retirer : refusé, rien d’effacé ; 3, retirées', async () => {
    for (const [index, code] of ['B', 'C', 'D', 'E'].entries()) await known(code, 1, index * 10)
    expect(await saveBlocks('ja', blocks, ['B', 'C', 'D', 'E'])).toContain('gardées (4)')
    expect(await setCodes()).toEqual(['B', 'C', 'D', 'E'])
    // Des codes que le catalogue ne connaît pas ne comptent pas.
    expect(await saveBlocks('ja', blocks, ['B', 'C', 'D', 'X1', 'X2'])).toBeNull()
    expect(await setCodes()).toEqual(['E'])
  })

  test('une carte dont l’id ou le rang ne sont pas des entiers positifs : écartée, comptée, rien de retiré ; un id Cardmarket mal formé : aucun, en texte : lu', async () => {
    const odd = [
      card({ id_card: 11, sort: 1 }),
      card({ id_card: '12' as unknown as number, sort: 2 }),
      card({ id_card: 0, sort: 3 }),
      card({ id_card: 13, sort: 0 }),
      card({ id_card: 14, sort: 1.5 }),
      card({ id_card: 15, sort: 10_000 }),
      card({ id_card: 16, sort: 4, id_cardmarket: -5 }),
      card({ id_card: 17, sort: 5, id_cardmarket: 1.5 }),
      card({ id_card: 18, sort: 6, id_cardmarket: 700_123 }),
      card({ id_card: 19, sort: 7, id_cardmarket: '700124' as unknown as number }),
      card({ id_card: 20, sort: 9_999 }),
    ]
    const series = page({ ...JAPANESE, code: 'ODD' }, odd)
    expect(await saveSeries('ja', 'ODD', series, READ_AT, null)).toMatchObject({
      saved: 6,
      rejected: 5,
    })
    expect(await rows('SELECT id, cardmarket FROM cards ORDER BY id')).toEqual([
      { id: 11, cardmarket: 0 },
      { id: 16, cardmarket: 0 },
      { id: 17, cardmarket: 0 },
      { id: 18, cardmarket: 700_123 },
      { id: 19, cardmarket: 700_124 },
      { id: 20, cardmarket: 0 },
    ])
    // Une lecture qui écarte une carte ne retire rien : la carte 11, relue mal formée, garde sa
    // ligne d'avant, et la 19, absente de la page, reste.
    const later = page({ ...JAPANESE, code: 'ODD' }, [
      card({ id_card: 11, sort: 0 }),
      ...odd.slice(6, 9),
    ])
    expect(await saveSeries('ja', 'ODD', later, LATER, null)).toMatchObject({
      saved: 3,
      rejected: 1,
    })
    expect(await rows('SELECT id, sort FROM cards WHERE id IN (11, 19) ORDER BY id')).toEqual([
      { id: 11, sort: 1 },
      { id: 19, sort: 7 },
    ])
    // Une lecture sans carte écartée retire celles qu'elle ne voit pas.
    const clean = page({ ...JAPANESE, code: 'ODD' }, odd.slice(6, 9))
    expect(await saveSeries('ja', 'ODD', clean, '2026-11-05T10:00:00.000Z', null)).toMatchObject({
      saved: 3,
      rejected: 0,
    })
    expect((await cards()).map(({ id }) => id)).toEqual([16, 17, 18])
  })
})
