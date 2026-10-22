/**
 * La lecture de Pokécardex dans une langue : quelles séries du plan du site sont japonaises ou
 * françaises (un code mal rangé ferait lire une page pour une autre, et mêler les cartes des deux
 * langues), et quels blocs du menu sont ceux d'une langue.
 */

import { describe, expect, test } from 'bun:test'
import { menuBlocks, seriesIn, type PokecardexSeries } from '@/lib/pokecardex'

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
