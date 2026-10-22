/**
 * Les images (`images.ts`) : les chemins français et japonais d'une même série (SVP) mènent chacun
 * à leur fichier, plausibles seulement si leur langue a la série (sinon une carte française
 * montrerait le scan d'une japonaise) ; une image qui n'est pas copiée répond 404 sans rien
 * télécharger (la tâche `images` les copie toutes d'avance) ; l'adresse d'origine de chaque chemin
 * (le scan français est celui du dossier `FR`, jamais celui sans langue, qui n'est pas lui).
 * Jamais le réseau : `fetch` est remplacé.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CardLanguage } from '../src/contract'
import { DATA_STEPS, migrate } from '../src/db'
import { cardScan, mirror, serveImage, setLogo } from '../src/images'
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
