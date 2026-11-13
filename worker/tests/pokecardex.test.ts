/**
 * La lecture de Pokécardex dans une langue : quelles séries du plan du site sont japonaises ou
 * françaises (un code mal rangé ferait lire une page pour une autre, et mêler les cartes des deux
 * langues ; un code que les chemins des images refusent arrêterait la tâche `images`), quels blocs
 * du menu sont ceux d'une langue, quelles séries sont des exclusivités d'autres pays d'Asie
 * (rangées avec les japonaises, mais pas japonaises : écartées), et le nom d'extension Cardmarket
 * d'une série française (un nom qui ne correspond pas au sien ferait tomber la liste de souhaits
 * sur une autre extension : mieux vaut aucun nom). Et le script d'où vient la clé de ses données :
 * seulement depuis le site lui-même, son adresse venant de la page. Jamais le réseau : `fetch` est
 * remplacé.
 */

import { describe, expect, test, vi } from 'vitest'
import {
  asiaExclusive,
  cardmarketSlug,
  expansionNameOf,
  menuBlocks,
  seriesIn,
  type PokecardexSeries,
} from '../ingest/pokecardex'

// Sans les 3 s d'attente entre deux pages ; `pokecardex.ts`, déjà chargé par l'entrée du Worker,
// rechargé pour le prendre.
vi.mock(import('../ingest/net'), async (original) => ({
  ...(await original()),
  sleep: async () => undefined,
}))
vi.resetModules()
const { readSeries } = await import('../ingest/pokecardex')

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.pokecardex.com</loc></url>
  <url><loc>https://www.pokecardex.com/series/jp</loc></url>
  <url><loc>https://www.pokecardex.com/series/chn</loc></url>
  <url><loc>https://www.pokecardex.com/series/jp/SV2A</loc></url>
  <url><loc>https://www.pokecardex.com/series/jp/SV2A</loc></url>
  <url><loc>https://www.pokecardex.com/series/chn/CS1</loc></url>
  <url><loc>https://www.pokecardex.com/series/MEG</loc></url>
  <url><loc>https://www.pokecardex.com/series/BS</loc></url>
  <url><loc>https://www.pokecardex.com/series/HS</loc></url>
</urlset>`

describe('le script de la clé de déchiffrement', () => {
  /** Une page de Pokécardex dont le script est à cette adresse. */
  const page = (script: string) =>
    new Response(
      `<script type="module" crossorigin src="${script}"></script>` +
        '<script>window.__INITIAL_DATA_ENCRYPTED__ = {"iv":"AAAA","data":"AAAA"}</script>',
    )

  test('seulement depuis le site lui-même : une adresse d’ailleurs est refusée sans être lue', async () => {
    const network = vi.spyOn(globalThis, 'fetch')
    try {
      for (const script of ['https://ailleurs.example/index.js', '//ailleurs.example/index.js']) {
        network.mockResolvedValueOnce(page(script))
        await expect(readSeries('ja', 'SV2A')).rejects.toThrow(
          'script hors du site (https://ailleurs.example)',
        )
      }
      // Celui du site est lu (ici sans clé : une erreur, mais après l'avoir lu).
      network.mockResolvedValueOnce(page('/assets/index-abc.js'))
      network.mockResolvedValueOnce(new Response('export {}'))
      await expect(readSeries('ja', 'SV2A')).rejects.toThrow('clé de ses données introuvable')
      expect(network.mock.calls.map(([url]) => String(url))).toEqual([
        'https://www.pokecardex.com/series/jp/SV2A',
        'https://www.pokecardex.com/series/jp/SV2A',
        'https://www.pokecardex.com/series/jp/SV2A',
        'https://www.pokecardex.com/assets/index-abc.js',
      ])
    } finally {
      network.mockRestore()
    }
  })
})

describe('seriesIn', () => {
  test('japonaises : /series/jp/<code>, sans doublon ni autre pays', () => {
    expect(seriesIn(SITEMAP, 'ja')).toEqual(['SV2A'])
  })

  test('françaises : /series/<code>, sans les pages d’index /series/jp et /series/chn', () => {
    expect(seriesIn(SITEMAP, 'fr')).toEqual(['MEG', 'BS', 'HS'])
  })

  // Les chemins des images n'acceptent que ces codes : une série d'un autre code ferait échouer
  // chacun de ses scans, et la tâche `images` s'arrêterait pour les deux langues.
  test('seulement les codes de majuscules, chiffres, « _ » et « - »', () => {
    const sitemap = `<urlset>
      <url><loc>https://www.pokecardex.com/series/jp/SV-P_2</loc></url>
      <url><loc>https://www.pokecardex.com/series/jp/SV2a</loc></url>
      <url><loc>https://www.pokecardex.com/series/MC8US</loc></url>
      <url><loc>https://www.pokecardex.com/series/Mcd</loc></url>
    </urlset>`
    expect(seriesIn(sitemap, 'ja')).toEqual(['SV-P_2'])
    expect(seriesIn(sitemap, 'fr')).toEqual(['MC8US'])
  })
})

/** Un bloc du menu des séries : son nom (le même en anglais), ses séries. */
const block = (name: string, ...codes: string[]) => ({
  name,
  nameUS: name,
  series: codes.map((shortName) => ({ shortName })),
})

describe('menuBlocks', () => {
  const page = {
    seriesMenu: {
      blocksByRegion: {
        JP: [block('Scarlet & Violet', 'SV2A')],
        FR: [block('Méga-Évolution', 'MEG'), block('Écarlate et Violet', 'SV1')],
      },
    },
  } as unknown as PokecardexSeries

  test('les blocs de la langue demandée, dans l’ordre du menu', () => {
    expect(menuBlocks(page, 'ja').map((entry) => entry.name)).toEqual(['Scarlet & Violet'])
    expect(menuBlocks(page, 'fr').map((entry) => entry.name)).toEqual([
      'Méga-Évolution',
      'Écarlate et Violet',
    ])
  })

  test('pas de menu : aucun bloc', () => {
    expect(menuBlocks({} as PokecardexSeries, 'fr')).toEqual([])
  })
})

describe('asiaExclusive', () => {
  test('les séries du bloc « Asia Exclusive » du menu japonais ; pas celles du menu français', () => {
    const page = {
      seriesMenu: {
        blocksByRegion: {
          JP: [block('Scarlet & Violet', 'SV2A'), block('Asia Exclusive', 'CS1', 'CSM1')],
          FR: [block('Asia Exclusive', 'MEG')],
        },
      },
    } as unknown as PokecardexSeries
    expect(asiaExclusive(page)).toEqual(new Set(['CS1', 'CSM1']))
  })
})

describe('cardmarketSlug', () => {
  test('le nom d’une extension tel que Cardmarket l’écrit dans ses adresses', () => {
    expect(cardmarketSlug('Mega Evolution')).toBe('Mega-Evolution')
    expect(cardmarketSlug('Pokémon Card 151')).toBe('Pokemon-Card-151')
    expect(cardmarketSlug('Sun & Moon')).toBe('Sun-Moon')
  })

  test('les apostrophes retirées, pas changées en tiret', () => {
    expect(cardmarketSlug("Champion's Path")).toBe('Champions-Path')
    expect(cardmarketSlug('Champion’s Path')).toBe('Champions-Path')
  })
})

describe('expansionNameOf', () => {
  const urls = ['Mega-Evolution/Bulbasaur-V1-MEG001', 'Mega-Evolution/Ivysaur-MEG002']

  test('le nom anglais de la série, quand toutes ses cartes sont de la même extension', () => {
    expect(expansionNameOf('Mega Evolution', urls)).toBe('Mega Evolution')
    expect(expansionNameOf('Pokémon Card 151', ['Pokemon-Card-151/Mew-V1-SV2A151'])).toBe(
      'Pokémon Card 151',
    )
  })

  test('une carte sans adresse ne compte pas', () => {
    expect(expansionNameOf('Mega Evolution', [null, '', ...urls])).toBe('Mega Evolution')
  })

  test('un nom qui ne correspond pas à l’adresse : aucun nom', () => {
    expect(expansionNameOf('Mega Evolution', ['Phantasmal-Flames/Mew-PFL001'])).toBe('')
  })

  test('des adresses d’extensions différentes : aucun nom', () => {
    expect(expansionNameOf('Mega Evolution', [...urls, 'Phantasmal-Flames/Mew-PFL001'])).toBe('')
  })

  test('aucune adresse, ou pas de nom : aucun nom', () => {
    expect(expansionNameOf('Mega Evolution', [])).toBe('')
    expect(expansionNameOf('Mega Evolution', [null, ''])).toBe('')
    expect(expansionNameOf(null, urls)).toBe('')
  })
})
