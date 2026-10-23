/**
 * La lecture de Pokécardex dans une langue : quelles séries du plan du site sont japonaises ou
 * françaises (un code mal rangé ferait lire une page pour une autre, et mêler les cartes des deux
 * langues ; un code que les chemins des images refusent arrêterait la tâche `images`), quels blocs
 * du menu sont ceux d'une langue, et le nom d'extension Cardmarket d'une série française (un nom
 * qui ne correspond pas au sien ferait tomber la liste de souhaits sur une autre extension : mieux
 * vaut aucun nom).
 */

import { describe, expect, test } from 'bun:test'
import {
  cardmarketSlug,
  expansionNameOf,
  menuBlocks,
  seriesIn,
  type PokecardexSeries,
} from '@/lib/pokecardex'

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

describe('menuBlocks', () => {
  const block = (name: string, code: string) => ({
    name,
    nameUS: name,
    series: [{ shortName: code }],
  })
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
