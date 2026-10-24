/**
 * Les images (`images.ts`) : les chemins français et japonais d'une même série (SVP) mènent chacun
 * à leur fichier, plausibles seulement si leur langue a la série (sinon une carte française
 * montrerait le scan d'une japonaise) ; une image qui n'est pas copiée répond 404 sans rien
 * télécharger (la tâche `images` les copie toutes d'avance) ; l'adresse d'origine de chaque chemin
 * (le scan français est celui du dossier `FR`, jamais celui sans langue, qui n'est pas lui). Après
 * une renumérotation d'une série par la source, la tâche `images` recopie le scan de chaque carte
 * cherchée (le fichier de son rang était celui d'une autre carte), ne garde aucun fichier pour une
 * carte que la source n'a pas (ni à sa recherche de la semaine suivante), et ne note jamais une
 * carte que le catalogue a déplacée pendant la copie. Jamais le réseau : `fetch` est remplacé.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CARD_TYPES } from '../src/config/catalog'
import { SPECIES_IDS } from '../src/config/pokedex'
import type { CardLanguage } from '../src/contract'
import { DATA_STEPS, migrate } from '../src/db'
import {
  artworkUrl,
  cardScan,
  mirror,
  serveImage,
  setLogo,
  spriteUrl,
  typeIcon,
} from '../src/images'
import { seriesWriter } from '../src/jobs/catalog'
import { images } from '../src/jobs/images'
import type { PokecardexSeries } from '../src/lib/pokecardex'
// Pour sa garde : les fichiers de ces tests vont dans le dossier temporaire de `setup.ts`.
import './server'

const IMAGES_DIR = process.env.IMAGES_DIR!

/** Le nombre de cartes de la série SVP dans chaque langue. */
const CARDS: Record<CardLanguage, number> = { ja: 1, fr: 3 }

/** Une base où seules ces langues ont la série SVP (ses cartes : de 1 à `CARDS[langue]`). */
function database(...languages: CardLanguage[]) {
  const db = new Database(':memory:', { strict: true })
  db.run('PRAGMA foreign_keys = ON')
  migrate(db, 'essai', DATA_STEPS)
  for (const lang of languages) {
    db.query(
      `INSERT INTO sets (lang, id, name, released, read_at)
       VALUES (?, 'SVP', 'Promos', '2023-01-01', '2026-10-22T10:00:00.000Z')`,
    ).run(lang)
    for (let sort = 1; sort <= CARDS[lang]; sort++) {
      db.query(
        `INSERT INTO cards (lang, id, set_id, number, sort, name, cardmarket, seen)
         VALUES (?, ?, 'SVP', ?, ?, 'Carte', 0, '2026-10-22T10:00:00.000Z')`,
      ).run(lang, sort, String(sort), sort)
    }
  }
  return db
}

/** Une image copiée chez nous, de ce contenu. */
function put(path: string, content: string) {
  const file = join(IMAGES_DIR, path.slice('/images/'.length))
  mkdirSync(dirname(file), { recursive: true })
  return Bun.write(file, content)
}

const serve = (db: Database, path: string) =>
  serveImage(db, new Request(`http://localhost/v1${path}`))

/** Ce que rend `serveImage` : le contenu du fichier, ou le statut d'une réponse sans fichier. */
async function served(db: Database, path: string) {
  const response = await serve(db, path)
  return response.status === 200 ? await response.text() : response.status
}

/** `fetch` remplacé par une fonction qui échoue : un essai ne touche jamais le réseau. */
const stubFetch = () =>
  spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Pas de réseau dans les tests'))
let network: ReturnType<typeof stubFetch>

// Aucune image d'un test à l'autre.
beforeEach(() => {
  rmSync(IMAGES_DIR, { recursive: true, force: true })
  network = stubFetch()
})
afterEach(() => network.mockRestore())

describe('les chemins par langue', () => {
  test('un chemin français ne mène qu’à une image française', async () => {
    expect(cardScan('ja', 'SVP', 1, 'md')).toBe('/images/cards/SVP/1-md.webp')
    expect(cardScan('fr', 'SVP', 1, 'md')).toBe('/images/cards/fr/SVP/1-md.webp')
    expect(setLogo('ja', 'SVP', 'hd')).toBe('/images/sets/SVP-hd.webp')
    expect(setLogo('fr', 'SVP', 'hd')).toBe('/images/sets/fr/SVP-hd.webp')

    await put('/images/cards/SVP/1-md.webp', 'scan japonais')
    await put('/images/cards/fr/SVP/1-md.webp', 'scan français')
    await put('/images/sets/SVP-hd.webp', 'logo japonais')
    await put('/images/sets/fr/SVP-hd.webp', 'logo français')
    await put('/images/cards/fr/SVP/3-md.webp', 'troisième scan français')
    await put('/images/cards/SVP/3-md.webp', 'troisième scan, sans carte japonaise')

    // La série dans les deux langues : chaque chemin son fichier.
    const both = database('ja', 'fr')
    expect(await served(both, '/images/cards/SVP/1-md.webp')).toBe('scan japonais')
    expect(await served(both, '/images/cards/fr/SVP/1-md.webp')).toBe('scan français')
    expect(await served(both, '/images/sets/SVP-hd.webp')).toBe('logo japonais')
    expect(await served(both, '/images/sets/fr/SVP-hd.webp')).toBe('logo français')
    // Le rang plausible est celui de la langue : 3 cartes en français, 1 en japonais.
    expect(await served(both, '/images/cards/fr/SVP/3-md.webp')).toBe('troisième scan français')
    expect(await served(both, '/images/cards/SVP/3-md.webp')).toBe(404)

    // La série en japonais seulement : rien en français, même avec le fichier.
    const japanese = database('ja')
    expect(await served(japanese, '/images/cards/SVP/1-md.webp')).toBe('scan japonais')
    expect(await served(japanese, '/images/sets/SVP-hd.webp')).toBe('logo japonais')
    expect(await served(japanese, '/images/cards/fr/SVP/1-md.webp')).toBe(404)
    expect(await served(japanese, '/images/sets/fr/SVP-hd.webp')).toBe(404)

    // La série en français seulement : rien en japonais.
    const french = database('fr')
    expect(await served(french, '/images/cards/fr/SVP/1-md.webp')).toBe('scan français')
    expect(await served(french, '/images/sets/fr/SVP-hd.webp')).toBe('logo français')
    expect(await served(french, '/images/cards/SVP/1-md.webp')).toBe(404)
    expect(await served(french, '/images/sets/SVP-hd.webp')).toBe(404)

    // L'icône d'une rareté est commune aux deux langues : celle d'un id que seule l'une connaît.
    french.run("INSERT INTO rarities (lang, id, name, rank) VALUES ('fr', 33, 'Double Rare', 1)")
    await put('/images/rarities/33.webp', 'icône')
    expect(await served(french, '/images/rarities/33.webp')).toBe('icône')
    expect(await served(japanese, '/images/rarities/33.webp')).toBe(404)
  })

  test('une image absente répond 404 sans rien télécharger', async () => {
    const db = database('ja', 'fr')
    db.run("INSERT INTO rarities (lang, id, name, rank) VALUES ('fr', 33, 'Double Rare', 1)")
    for (const path of [
      '/images/cards/SVP/1-md.webp',
      '/images/cards/fr/SVP/2-hd.webp',
      '/images/sets/SVP-md.webp',
      '/images/sets/fr/SVP-md.webp',
      '/images/rarities/33.webp',
      '/images/types/1.webp',
      '/images/species/25.png',
      '/images/species/artwork/25.png',
    ]) {
      expect([path, await served(db, path)]).toEqual([path, 404])
    }
    expect(network).not.toHaveBeenCalled()
  })
})

describe('une série renumérotée par la source', () => {
  // Les chemins des scans suivent le rang : après l'arrivée d'une carte en tête de série, le
  // fichier du rang 1 est celui de l'ancienne première carte, qu'il ne faut jamais garder.
  const READ_AT = '2026-10-20T10:00:00.000Z'
  const LATER = '2026-10-21T10:00:00.000Z'

  /**
   * La série X chez la source : ses cartes, dans son ordre (leur rang : 1, 2…), et les tailles de
   * leur scan qu'elle a (toutes, sans précision).
   */
  type SourceCard = [id: number, name: string, sizes?: ('md' | 'hd')[]]
  let source: SourceCard[] = []

  /** La page de la série X telle que la source la donne à ce moment. */
  const seriesPage = (): PokecardexSeries => ({
    currentSeries: { shortName: 'X', fullName: 'Série X', releaseDateFR: '2026-10-01 00:00:00' },
    cartes: source.map(([id_card, name], index) => ({
      id_card,
      sort: index + 1,
      num_card: `${index + 1}/100`,
      name_card_fr: name,
      name_card_en: name,
      name_card_de: name,
      id_pokedex_list: [],
      id_cardmarket: null,
      cardmarket_url: null,
      only_english: 0,
      id_rarete: null,
      id_type: null,
      nom_illustrateur: '',
      versions: [],
    })),
  })

  /** La source change : ses cartes, et la lecture de la série par le catalogue. */
  const sourceHas = (db: Database, cards: SourceCard[], readAt: string) => {
    source = cards
    seriesWriter(db).save('ja', 'X', seriesPage(), readAt, null)
  }

  /** Le scan de chaque rang de la série X chez la source : « scan de <carte> », sinon 404. */
  const scanOf = (url: string) => {
    const [, rank, size] = /\/sets_jp\/X\/(\d+)\.jpg\?class=(md|hd)/.exec(url)!
    const card = source[Number(rank) - 1]
    return card && (card[2] ?? ['md', 'hd']).includes(size as 'md' | 'hd')
      ? new Response(`scan de ${card[1]}`, { headers: { 'Content-Type': 'image/webp' } })
      : new Response(null, { status: 404 })
  }

  /** `fetch` remplacé par la source : `meanwhile` (ce qui y change à ce moment), puis le scan. */
  const sourceAnswers = (meanwhile = () => {}) =>
    network.mockImplementation((async (url: string | URL | Request) => {
      meanwhile()
      return scanOf(String(url))
    }) as typeof fetch)

  /** Déjà copiées : les images d'avant les scans (logo, icônes, Pokémon), sans requête. */
  const copiedBesidesScans = () =>
    Promise.all([
      put(setLogo('ja', 'X', 'md'), 'logo'),
      put(setLogo('ja', 'X', 'hd'), 'logo'),
      ...[...CARD_TYPES].map((type) => put(typeIcon(type), 'icône')),
      ...SPECIES_IDS.flatMap((id) => [put(spriteUrl(id), 'sprite'), put(artworkUrl(id), 'art')]),
    ])

  const scans = async (db: Database, ranks: number) => {
    const files: (string | number)[] = []
    for (let rank = 1; rank <= ranks; rank++) {
      files.push(await served(db, cardScan('ja', 'X', rank, 'md')))
      files.push(await served(db, cardScan('ja', 'X', rank, 'hd')))
    }
    return files
  }

  const noted = (db: Database) =>
    db.query("SELECT id, sort, image FROM cards WHERE lang = 'ja' ORDER BY sort").all()

  test('une carte arrivée en tête : chaque carte retrouve son scan, recopié par la tâche', async () => {
    const db = database()
    await copiedBesidesScans()
    sourceAnswers()
    sourceHas(
      db,
      [
        [10, 'Pikachu'],
        [11, 'Raichu'],
      ],
      READ_AT,
    )
    await images(db)
    expect(await scans(db, 2)).toEqual([
      'scan de Pikachu',
      'scan de Pikachu',
      'scan de Raichu',
      'scan de Raichu',
    ])

    // Pichu arrive en tête : Pikachu passe au rang 2, Raichu au 3 (le catalogue les remet à
    // chercher), Pichu prend le rang 1, dont le fichier est celui de Pikachu.
    sourceHas(
      db,
      [
        [12, 'Pichu'],
        [10, 'Pikachu'],
        [11, 'Raichu'],
      ],
      LATER,
    )
    await images(db)
    expect(await scans(db, 3)).toEqual([
      'scan de Pichu',
      'scan de Pichu',
      'scan de Pikachu',
      'scan de Pikachu',
      'scan de Raichu',
      'scan de Raichu',
    ])
    expect(noted(db)).toEqual([
      { id: 12, sort: 1, image: 'pokecardex' },
      { id: 10, sort: 2, image: 'pokecardex' },
      { id: 11, sort: 3, image: 'pokecardex' },
    ])
  })

  /**
   * Pichu arrive en tête sans scan chez la source (`sizes` : seulement ces tailles) : le fichier du
   * rang 1, celui de Pikachu, n'est jamais servi pour lui ni gardé, même à la recherche de la
   * semaine suivante.
   */
  async function arrivedWithoutScan(sizes: ('md' | 'hd')[]) {
    const db = database()
    await copiedBesidesScans()
    sourceAnswers()
    sourceHas(db, [[10, 'Pikachu']], READ_AT)
    await images(db)
    sourceHas(
      db,
      [
        [12, 'Pichu', sizes],
        [10, 'Pikachu'],
      ],
      LATER,
    )
    await images(db)
    const files = [404, 404, 'scan de Pikachu', 'scan de Pikachu']
    const notes = [
      { id: 12, sort: 1, image: 'none' },
      { id: 10, sort: 2, image: 'pokecardex' },
    ]
    expect(await scans(db, 2)).toEqual(files)
    expect(noted(db)).toEqual(notes)
    // La semaine suivante, la carte sans scan est cherchée de nouveau ; la source ne l'a toujours pas.
    db.run("UPDATE cards SET image_checked = '2026-01-01T00:00:00.000Z' WHERE image = 'none'")
    await images(db)
    expect(await scans(db, 2)).toEqual(files)
    expect(noted(db)).toEqual(notes)
  }

  test('une carte arrivée en tête sans scan chez la source : jamais celui de sa voisine', () =>
    arrivedWithoutScan([]))

  test('une carte arrivée en tête avec un seul de ses deux scans : jamais celui de sa voisine', () =>
    arrivedWithoutScan(['md']))

  test('une carte que le catalogue déplace pendant sa copie n’est pas notée à son ancien rang', async () => {
    const db = database()
    await copiedBesidesScans()
    sourceHas(db, [[10, 'Pikachu']], READ_AT)
    // Le catalogue, dans un autre processus, relit la série pendant la copie du scan de Pikachu
    // (rang 1) : Pichu arrive en tête, Pikachu passe au rang 2.
    let moved = false
    sourceAnswers(() => {
      if (!moved) {
        moved = true
        sourceHas(
          db,
          [
            [12, 'Pichu'],
            [10, 'Pikachu'],
          ],
          LATER,
        )
      }
    })
    await images(db)
    // Le rang 1 copié est celui de Pichu ; Pikachu, au rang 2, reste à chercher.
    expect(noted(db)).toEqual([
      { id: 12, sort: 1, image: null },
      { id: 10, sort: 2, image: null },
    ])

    await images(db)
    expect(await scans(db, 2)).toEqual([
      'scan de Pichu',
      'scan de Pichu',
      'scan de Pikachu',
      'scan de Pikachu',
    ])
    expect(noted(db)).toEqual([
      { id: 12, sort: 1, image: 'pokecardex' },
      { id: 10, sort: 2, image: 'pokecardex' },
    ])
  })
})

describe('l’adresse d’origine', () => {
  test('le scan français est celui du dossier FR, jamais celui sans langue', async () => {
    const paths = [
      cardScan('ja', 'SVP', 1, 'md'),
      cardScan('fr', 'SVP', 1, 'hd'),
      setLogo('ja', 'SVP', 'md'),
      setLogo('fr', 'SVP', 'hd'),
    ]
    for (const path of paths) {
      network.mockResolvedValueOnce(
        new Response('image', { headers: { 'Content-Type': 'image/webp' } }),
      )
      expect(await mirror(path)).toBe(true)
      expect(await Bun.file(join(IMAGES_DIR, path.slice('/images/'.length))).text()).toBe('image')
    }
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([
      'https://pokecardex-scans.b-cdn.net/sets_jp/SVP/1.jpg?class=md',
      'https://pokecardex-scans.b-cdn.net/sets/SVP/FR/1.jpg?class=hd',
      'https://pokecardex.b-cdn.net/assets/images/logos_jp/SVP.png?class=md',
      'https://pokecardex.b-cdn.net/assets/images/logos/SVP.png?class=hd',
    ])
  })
})
