/**
 * Le catalogue dans deux langues (`jobs/catalog.ts`) : chez Pokécardex, les ids des cartes, les
 * codes des séries et les ids des raretés se répètent d'une zone à l'autre (la carte 7091 :
 * Regirock de SM4A au Japon, Alakazam du Set de base en France). Une carte d'une langue ne doit
 * jamais écraser ni retirer celle de l'autre, ni une réponse d'une langue montrer l'autre ; une
 * carte qui n'existe qu'en anglais n'entre pas au catalogue français ; le nom d'extension
 * Cardmarket d'une série (la liste de souhaits) : jamais un nom que ses cartes ne confirment pas.
 */

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { DATA_STEPS, migrate } from '../src/db'
import { saveCatalog, seriesWriter, snapshotName } from '../src/jobs/catalog'
import type { PokecardexCard, PokecardexSeries } from '../src/lib/pokecardex'

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

/** Une série : son code, son nom, sa zone du menu et son bloc, le nom de sa rareté 48. */
interface Series {
  code: string
  fullName: string
  region: 'JP' | 'FR'
  block: string
  rarity: string
}

/** La page d'une série, son menu (son seul bloc) et les raretés de sa zone. */
const page = (
  { code, fullName, region, block, rarity }: Series,
  cartes: PokecardexCard[],
): PokecardexSeries => ({
  currentSeries: { shortName: code, fullName, releaseDateFR: '2023-06-16 00:00:00' },
  cartes,
  raretes: [{ id_rarete: 48, nom_rarete: rarity, order_rarete: 1 }],
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
  rarity: 'FUR',
}
const FRENCH: Series = {
  code: 'SVP',
  fullName: 'Promos Écarlate et Violet',
  region: 'FR',
  block: 'Écarlate et Violet',
  rarity: 'Futuriste Rare',
}
/** La carte 7091 des deux zones : Regirock au Japon, Alakazam en France. */
const REGIROCK = card({ id_card: 7091, sort: 1, name_card_fr: 'Regirock', id_pokedex_list: [377] })
const ALAKAZAM = card({ id_card: 7091, sort: 1, name_card_fr: 'Alakazam', id_pokedex_list: [65] })

let db: Database

beforeEach(() => {
  db = new Database(':memory:', { strict: true })
  // Comme `openData` : les clés étrangères actives.
  db.run('PRAGMA foreign_keys = ON')
  migrate(db, 'essai', DATA_STEPS)
})

/** Une réponse enregistrée, décompressée ; `null` si elle n'existe pas. */
function snapshot(name: string) {
  const row = db.query('SELECT body FROM snapshots WHERE name = ?').get(name) as {
    body: Uint8Array<ArrayBuffer>
  } | null
  return row && JSON.parse(new TextDecoder().decode(Bun.gunzipSync(row.body)))
}

const cards = () =>
  db
    .query(
      `SELECT lang, id, set_id AS 'set', name,
              (SELECT json_group_array(dex_id) FROM card_species
               WHERE card_species.lang = cards.lang AND card = cards.id) AS dexIds
       FROM cards ORDER BY lang, id`,
    )
    .all()

describe('seriesWriter', () => {
  test('une série et une carte françaises au même code et au même id que des japonaises coexistent', () => {
    const writer = seriesWriter(db)
    writer.save('ja', 'SVP', page(JAPANESE, [REGIROCK]), READ_AT, null)
    writer.save('fr', 'SVP', page(FRENCH, [ALAKAZAM]), READ_AT, null)
    expect(cards()).toEqual([
      { lang: 'fr', id: 7091, set: 'SVP', name: 'Alakazam', dexIds: '[65]' },
      { lang: 'ja', id: 7091, set: 'SVP', name: 'Regirock', dexIds: '[377]' },
    ])
    expect(db.query('SELECT lang, id, name FROM sets ORDER BY lang').all()).toEqual([
      { lang: 'fr', id: 'SVP', name: 'Promos Écarlate et Violet' },
      { lang: 'ja', id: 'SVP', name: 'SV-P Promo' },
    ])
    expect(writer.known('ja', 'SVP')).toBe(1)
    expect(writer.known('fr', 'SVP')).toBe(1)

    // La série japonaise relue sans la carte 7091 : seule la japonaise est retirée.
    const other = card({ id_card: 7092, sort: 2, name_card_fr: 'Regice', id_pokedex_list: [378] })
    writer.save('ja', 'SVP', page(JAPANESE, [other]), LATER, null)
    expect(cards()).toEqual([
      { lang: 'fr', id: 7091, set: 'SVP', name: 'Alakazam', dexIds: '[65]' },
      { lang: 'ja', id: 7092, set: 'SVP', name: 'Regice', dexIds: '[378]' },
    ])
  })

  test('une carte only_english n’entre pas au catalogue français', () => {
    const english = card({ id_card: 7092, sort: 2, name_card_fr: 'Shadowless', only_english: 1 })
    seriesWriter(db).save('fr', 'SVP', page(FRENCH, [ALAKAZAM, english]), READ_AT, null)
    expect(cards()).toEqual([
      { lang: 'fr', id: 7091, set: 'SVP', name: 'Alakazam', dexIds: '[65]' },
    ])
  })

  test('le nom d’extension Cardmarket : celui d’une japonaise, d’une française son nom anglais confirmé par ses cartes', () => {
    const writer = seriesWriter(db)
    const expansion = (lang: string, code: string) =>
      (
        db
          .query('SELECT expansion_name AS name FROM sets WHERE lang = ? AND id = ?')
          .get(lang, code) as { name: string }
      ).name
    const meg = (code: string) => ({ ...FRENCH, code, fullName: 'Méga-Évolution' })
    const bulbizarre = card({
      id_card: 1,
      sort: 1,
      cardmarket_url: 'Mega-Evolution/Bulbasaur-V1-MEG001',
    })
    writer.save('ja', 'SVP', page(JAPANESE, [REGIROCK]), READ_AT, null)
    writer.save('fr', 'MEG', page(meg('MEG'), [bulbizarre]), READ_AT, 'Mega Evolution')
    writer.save(
      'fr',
      'PFL',
      page(meg('PFL'), [{ ...bulbizarre, id_card: 2 }]),
      READ_AT,
      'Phantasmal Flames',
    )
    writer.save('fr', 'ASC', page(meg('ASC'), [{ ...bulbizarre, id_card: 3 }]), READ_AT, null)
    expect(expansion('ja', 'SVP')).toBe('SV-P Promo')
    expect(expansion('fr', 'MEG')).toBe('Mega Evolution')
    // Un nom que les adresses de ses cartes ne confirment pas, ou aucun nom : aucun.
    expect(expansion('fr', 'PFL')).toBe('')
    expect(expansion('fr', 'ASC')).toBe('')
  })
})

describe('snapshotName', () => {
  test('les réponses japonaises gardent leurs noms, les françaises ont les leurs', () => {
    expect(snapshotName('ja', 'sets')).toBe('catalog/sets')
    expect(snapshotName('ja', 'sets/SVP')).toBe('catalog/sets/SVP')
    expect(snapshotName('ja', 'species/377')).toBe('catalog/species/377')
    expect(snapshotName('fr', 'sets')).toBe('catalog/fr/sets')
    expect(snapshotName('fr', 'sets/SVP')).toBe('catalog/fr/sets/SVP')
    expect(snapshotName('fr', 'species/65')).toBe('catalog/fr/species/65')
  })
})

describe('saveCatalog', () => {
  /** Les deux séries SVP, leurs blocs et leurs raretés, puis les réponses. */
  function saveBoth() {
    const writer = seriesWriter(db)
    const japanese = page(JAPANESE, [REGIROCK])
    const french = page(FRENCH, [ALAKAZAM])
    writer.save('ja', 'SVP', japanese, READ_AT, null)
    writer.save('fr', 'SVP', french, READ_AT, null)
    writer.rarities('ja', japanese)
    writer.rarities('fr', french)
    writer.blocks('ja', japanese)
    writer.blocks('fr', french)
    saveCatalog(db)
    return writer
  }

  test('saveCatalog fait des réponses distinctes par langue', () => {
    saveBoth()
    expect(snapshot('catalog/sets')).toEqual({
      blocks: ['Scarlet & Violet'],
      sets: [['SVP', 'SV-P Promo', '2023-06-16', 1, 1, 0, 0]],
    })
    expect(snapshot('catalog/fr/sets')).toEqual({
      blocks: ['Écarlate et Violet'],
      sets: [['SVP', 'Promos Écarlate et Violet', '2023-06-16', 1, 1, 0, 0]],
    })
    expect(snapshot('catalog/sets/SVP')).toMatchObject({
      cards: [{ name: 'Regirock', dexIds: [377] }],
      rarities: { 48: ['FUR', 1] },
    })
    expect(snapshot('catalog/fr/sets/SVP')).toMatchObject({
      cards: [{ name: 'Alakazam', dexIds: [65] }],
      rarities: { 48: ['Futuriste Rare', 1] },
    })
    expect(snapshot('catalog/species/377').cards[377]).toHaveLength(1)
    expect(snapshot('catalog/fr/species/65').cards[65]).toHaveLength(1)
    expect(snapshot('catalog/species/65').cards).toEqual({})
    expect(snapshot('catalog/fr/species/377').cards).toEqual({})
  })

  test('les réponses d’une série retirée ne sont retirées que dans sa langue', () => {
    const writer = saveBoth()
    writer.save(
      'fr',
      'MEG',
      page({ ...FRENCH, code: 'MEG' }, [card({ id_card: 1, sort: 1 })]),
      READ_AT,
      null,
    )
    writer.remove('fr', 'SVP')
    saveCatalog(db)
    expect(snapshot('catalog/fr/sets/SVP')).toBeNull()
    expect(snapshot('catalog/fr/sets/MEG')).not.toBeNull()
    expect(snapshot('catalog/sets/SVP')).not.toBeNull()
  })

  test('une langue sans cartes : aucune réponse (l’API répond 404)', () => {
    seriesWriter(db).save('ja', 'SVP', page(JAPANESE, [REGIROCK]), READ_AT, null)
    saveCatalog(db)
    expect(snapshot('catalog/sets')).not.toBeNull()
    expect(snapshot('catalog/fr/sets')).toBeNull()
    expect(snapshot('catalog/fr/species/65')).toBeNull()
  })
})
