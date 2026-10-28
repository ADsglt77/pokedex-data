/**
 * Pokécardex (pokecardex.com), avec son accord (octobre 2026 : lire ce qu'on veut sur son site,
 * utiliser ses images, copiées chez nous). Il ne fournit ni export ni API : chaque page
 * porte ses données chiffrées (AES-CBC, `__INITIAL_DATA_ENCRYPTED__`), que son propre JavaScript
 * déchiffre. On fait de même, avec la clé lue dans ce JavaScript et relue quand son adresse
 * change (à chaque mise en ligne du site), jamais recopiée ici.
 * Une page toutes les 3 s, User-Agent identifié. S'il présentait un défi anti-robot (Cloudflare),
 * la lecture échouerait : on ne le contourne pas.
 */

import type { CardLanguage } from '@/contract'
import { download } from './net'

const SITE = 'https://www.pokecardex.com'
/** Une requête toutes les 3 s au plus. */
const PACE = 3000

/**
 * Autant de pages en échec d'affilée (tâches `catalog` et `history`) : le site a changé (clé
 * introuvable, défi anti-robot…), on ne le sollicite pas davantage ; la tâche est relancée plus
 * tard.
 */
export const MAX_FAILURES_IN_A_ROW = 10

/** Une carte d'une série, telle que Pokécardex la donne (ce qu'on en lit). */
export interface PokecardexCard {
  id_card: number
  /** « 001/165 », « 001/SV-P », « — » (séries sans numéros), « SV-P ». */
  num_card: string
  /** Son rang dans la série, et le numéro de son image (`sets_jp/SV2A/1.jpg`). */
  sort: number
  name_card_fr: string | null
  name_card_en: string | null
  name_card_de: string | null
  /** Ses Pokémon (numéros du Pokédex) ; vide pour un dresseur ou une énergie. */
  id_pokedex_list: number[] | null
  id_cardmarket: number | null
  /** Son adresse chez Cardmarket : l'extension, puis la carte (« Mega-Evolution/Bulbasaur-V1-MEG001 »). */
  cardmarket_url: string | null
  /** 1 : la carte n'existe qu'en anglais (0 sur toutes les cartes françaises lues). */
  only_english: number | null
  /** Sa rareté (`raretes` de la page). */
  id_rarete: number | null
  /** Son type (`CARD_TYPES`, `src/config/catalog.ts`), ou sa catégorie de dresseur, ou énergie. */
  id_type: number | null
  nom_illustrateur: string | null
  /** Ses versions : « Standard », « Reverse », « Reverse Masterball »… */
  versions: { nom_version: string }[] | null
}

/**
 * Un bloc du menu des séries (« Scarlet & Violet ») : ses séries en boosters, puis ses decks (les
 * blocs français n'en ont pas : leurs decks sont des séries).
 */
interface PokecardexBlock {
  name: string
  nameUS: string
  /** Ses séries, avec leur nom dans la langue de la page (`fullName`). */
  series: { shortName: string; fullName: string }[]
  decks?: { shortName: string }[]
}

/** Une série : sa page (`/series/jp/SV2A` au Japon, `/series/MEG` en France). */
export interface PokecardexSeries {
  currentSeries: {
    shortName: string
    fullName: string
    /** « 2023-06-16 00:00:00 » : sa sortie au Japon, ou en France pour une série française. */
    releaseDateFR: string | null
  }
  cartes: PokecardexCard[]
  /** Toutes ses raretés (pas seulement celles de la série), dans son ordre. */
  raretes?: { id_rarete: number; nom_rarete: string; order_rarete: number }[]
  /** Le menu des séries, par bloc (« Scarlet & Violet », « Asia Exclusive »…), des plus récents aux plus anciens. */
  seriesMenu?: { blocksByRegion?: { JP?: PokecardexBlock[]; FR?: PokecardexBlock[] } }
}

/** Les blocs du menu de la page pour une langue, dans son ordre. */
export const menuBlocks = (page: PokecardexSeries, lang: CardLanguage) =>
  page.seriesMenu?.blocksByRegion?.[lang === 'ja' ? 'JP' : 'FR'] ?? []

/**
 * Les séries du bloc « Asia Exclusive » du menu japonais (Chine, Hong Kong et Taïwan, Indonésie,
 * Thaïlande, Corée) : rangées avec les japonaises, mais pas japonaises.
 */
export const asiaExclusive = (page: PokecardexSeries) =>
  new Set(
    menuBlocks(page, 'ja')
      .filter((block) => /asia exclusive/i.test(block.nameUS))
      .flatMap((block) => block.series.map((series) => series.shortName)),
  )

let last = 0

/** Le texte d'une adresse de Pokécardex, au plus une requête toutes les 3 s. */
async function read(url: string) {
  const wait = last + PACE - Date.now()
  if (wait > 0) await Bun.sleep(wait)
  last = Date.now()
  return (await download(url)).text()
}

/**
 * Les codes des séries d'une langue d'après le plan du site (« SV2A », « OR1 » ; « MEG », « BS »…) :
 * `/series/jp/<code>` au Japon, `/series/<code>` en France. Seulement des majuscules, des chiffres,
 * `_` et `-`, ce que permettent les chemins des images (`UPSTREAMS`, `images.ts`) : une série d'un
 * autre code, chacun de ses scans ferait une erreur de la tâche `images`, qui s'arrêterait à la
 * 20e, pour les deux langues. Les pages d'index des régions (`/series/jp`, `/series/chn`), en
 * minuscules, n'en sont pas.
 */
export function seriesIn(sitemap: string, lang: CardLanguage) {
  const pattern =
    lang === 'ja' ? /\/series\/jp\/([A-Z0-9_-]+)<\/loc>/g : /\/series\/([A-Z0-9_-]+)<\/loc>/g
  return [...new Set([...sitemap.matchAll(pattern)].map((match) => match[1]!))]
}

/** Les codes des séries d'une langue, d'après le plan du site. */
export async function seriesCodes(lang: CardLanguage) {
  const codes = seriesIn(await read(`${SITE}/sitemap_fr.xml`), lang)
  if (!codes.length) {
    throw new Error(
      `Pokécardex : aucune série ${lang === 'ja' ? 'japonaise' : 'française'} dans son plan du site`,
    )
  }
  return codes
}

/** La clé de déchiffrement, et le script d'où elle vient. */
let decryption: { script: string; key: CryptoKey } | null = null

/** La clé du script de la page : relue seulement quand le script change. */
async function keyOf(script: string) {
  if (decryption?.script === script) return decryption.key
  const code = await read(new URL(script, SITE).href)
  // La constante que la fonction de déchiffrement passe à `TextEncoder().encode(…)`.
  const name =
    /new TextEncoder\(\)\.encode\((\w+)\),\w+=await crypto\.subtle\.importKey\("raw"/.exec(
      code,
    )?.[1]
  const secret = name && new RegExp(`const ${name}="([^"]+)"`).exec(code)?.[1]
  if (!secret) throw new Error('Pokécardex : clé de ses données introuvable (le site a changé ?)')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  )
  decryption = { script, key }
  return key
}

/** Du base64 tel qu'il est écrit dans la page : en JSON, ses « / » sont échappés. */
const bytes = (base64: string) =>
  Uint8Array.from(atob(base64.replaceAll('\\/', '/')), (char) => char.charCodeAt(0))

/** Les données d'une page, déchiffrées comme le fait le site. */
async function pageData<T>(path: string): Promise<T> {
  const html = await read(`${SITE}${path}`)
  const script = /<script type="module" crossorigin src="([^"]+)"/
    .exec(html)?.[1]
    ?.replaceAll('&#x2F;', '/')
  const found = /__INITIAL_DATA_ENCRYPTED__ = \{"iv":"([^"]+)","data":"([^"]+)"\}/.exec(html)
  if (!script || !found) throw new Error(`Pokécardex : pas de données dans ${path}`)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: bytes(found[1]!) },
    await keyOf(script),
    bytes(found[2]!),
  )
  return JSON.parse(new TextDecoder().decode(plain)) as T
}

/** La page d'une série : son nom, sa date, ses cartes. */
export const readSeries = (lang: CardLanguage, code: string) =>
  pageData<PokecardexSeries>(`/series/${lang === 'ja' ? 'jp/' : ''}${code}`)

/**
 * L'historique des prix d'une carte sur une période : ses séries (une par version, variante et
 * prix suivi) et leurs points, un par jour relevé (`{ date, <id de série>: prix }`).
 */
export interface PokecardexHistory {
  series: { id: string; versionId: number | null; variant: string; metric: string }[]
  points: ({ date: string } & Record<string, number | string | null>)[]
}

/** La page d'une carte (`/carte/jp/22819`, `/carte/7091`), ce qu'on en lit : ses prix Cardmarket. */
export interface PokecardexCardPage {
  carte: {
    /** Ses produits Cardmarket : celui de la carte (`id_version` nul), ceux de ses versions. */
    cardmarketPrices?: { id_cardmarket: string; id_version: number | null }[] | null
    /** Son historique Cardmarket, par période (« 15 », « 30 », « 90 », « 180 » jours). */
    priceHistory?: { cardmarket?: Record<string, PokecardexHistory> | null } | null
  }
}

/** La page d'une carte, par son id chez Pokécardex (celui du catalogue). */
export const readCard = (lang: CardLanguage, id: number) =>
  pageData<PokecardexCardPage>(`/carte/${lang === 'ja' ? 'jp/' : ''}${id}`)

/**
 * Les noms anglais des séries françaises, par code, d'après le menu d'une page anglaise
 * (`/en/series/<code>`, la même que la française dans l'autre langue : son menu donne le nom
 * anglais de chacune). Celui que Cardmarket donne à son extension, mais seulement s'il s'accorde
 * avec ses adresses (`expansionNameOf`) ; aucune page française ne le donne. Une page lue pour
 * toutes les séries.
 */
export async function readEnglishSeriesNames(code: string) {
  const page = await pageData<PokecardexSeries>(`/en/series/${code}`)
  return new Map(
    menuBlocks(page, 'fr').flatMap((block) =>
      block.series.map((series) => [series.shortName, series.fullName] as const),
    ),
  )
}

/**
 * Un nom d'extension écrit comme dans une adresse de Cardmarket : sans accents ni apostrophes,
 * chaque suite de signes à la place d'un tiret (« Pokémon Card 151 » : « Pokemon-Card-151 »,
 * « Sun & Moon » : « Sun-Moon », « Champion's Path » : « Champions-Path »).
 */
export const cardmarketSlug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Le nom d'extension Cardmarket d'une série française : son nom anglais, si toutes les adresses de
 * ses cartes (`cardmarket_url`) commencent par lui, tel que Cardmarket l'écrit. Sinon '' : mieux
 * vaut aucun nom (la liste de souhaits ne donne alors pas de ligne) qu'un nom qui désignerait une
 * autre extension.
 */
export function expansionNameOf(englishName: string | null, cardmarketUrls: (string | null)[]) {
  const segments = new Set(
    cardmarketUrls.filter((url): url is string => !!url).map((url) => url.split('/')[0]),
  )
  const matches = englishName && segments.size === 1 && segments.has(cardmarketSlug(englishName))
  return matches ? englishName : ''
}
