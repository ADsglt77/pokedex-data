/**
 * Les images, copiées chez nous (`IMAGES_DIR`, le volume `images` sur le VPS), que l'API sert à
 * `/v1/images/…` (le site les rend à `/images/…`, gardées en cache par son nginx) : chez Pokécardex
 * (avec son accord, qui demande de les héberger chez nous), les cartes et le logo de chaque série,
 * japonais et français, et les icônes des types et des raretés ; chez PokéAPI, les sprites et
 * illustrations des Pokémon. Leurs chemins sont neutres (`cardScan`…) : seule la table `UPSTREAMS`
 * connaît l'adresse d'origine de chacun. Toutes sont copiées d'avance, par la tâche `images`
 * (`jobs/images.ts`) : l'API ne télécharge jamais rien, une image qui n'est pas là répond 404.
 */

import type { Database } from 'bun:sqlite'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CARD_TYPES } from '@/config/catalog'
import { TOTAL_SPECIES } from '@/config/pokedex'
import type { CardLanguage } from '@/contract'
import { DATA_DIR } from './db'
import { politeFetch } from './lib/net'
import { notFound } from './snapshots'

const IMAGES_DIR = process.env.IMAGES_DIR ?? join(DATA_DIR, 'images')

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'
/** Les scans des cartes de Pokécardex, en WebP (`class`) : `sets_jp/` pour les japonaises. */
const SCANS = 'https://pokecardex-scans.b-cdn.net'
/** Les images du site de Pokécardex, en WebP (`class`) : logos, icônes. */
const ASSETS = 'https://pokecardex.b-cdn.net/assets/images'

/* Les chemins des images (le site les rend à son adresse, `/images/…`) : sans nom de source */

/**
 * Le dossier d'une langue dans les chemins : aucun pour le japonais (ses adresses, venues d'abord,
 * n'ont pas changé), `fr/` pour le français. Les codes des séries se répètent d'une langue à
 * l'autre (SVP) : sans lui, deux images auraient le même chemin.
 */
const folderOf = (lang: CardLanguage) => (lang === 'fr' ? 'fr/' : '')

/**
 * Le scan d'une carte : sa langue, le code de sa série et son rang (celui du catalogue), en deux
 * tailles, `md` pour les grilles, `hd` pour la fiche.
 */
export const cardScan = (
  lang: CardLanguage,
  set: string,
  rank: number | string,
  size: 'md' | 'hd',
) => `/images/cards/${folderOf(lang)}${set}/${rank}-${size}.webp`

/** Le logo d'une série, en deux tailles : `md` pour la liste, `hd` en tête de page. */
export const setLogo = (lang: CardLanguage, set: string, size: 'md' | 'hd') =>
  `/images/sets/${folderOf(lang)}${set}-${size}.webp`

/** L'icône d'un type de carte (`CARD_TYPES`). */
export const typeIcon = (type: number) => `/images/types/${type}.webp`

/** L'icône d'une rareté (« SAR », ●…), la même dans les deux langues : une par id chez la source. */
export const rarityIcon = (rarity: number) => `/images/rarities/${rarity}.webp`

/** Le sprite et l'illustration officielle d'un Pokémon. */
export const spriteUrl = (id: number) => `/images/species/${id}.png`
export const artworkUrl = (id: number) => `/images/species/artwork/${id}.png`

/** Un nombre lu dans un chemin. */
const within = (value: string, min: number, max: number) =>
  Number(value) >= min && Number(value) <= max

/** Un scan est plausible jusqu'au plus grand rang des cartes de la série, dans cette langue. */
const plausibleScan = (lang: CardLanguage) => (data: Database, set: string, rank: string) => {
  const { max } = data
    .query('SELECT MAX(sort) AS max FROM cards WHERE lang = ? AND set_id = ?')
    .get(lang, set) as { max: number | null }
  return max !== null && within(rank, 1, max)
}

/** Un logo est plausible pour une série de cette langue. */
const plausibleLogo = (lang: CardLanguage) => (data: Database, set: string) =>
  data.query('SELECT 1 FROM sets WHERE lang = ? AND id = ?').get(lang, set) !== null

/**
 * Les chemins locaux connus : l'adresse d'origine de chacun (que copie `mirror`), et s'il est
 * plausible (une série du catalogue, dans sa langue, et un numéro d'image jusqu'au plus grand des
 * siens, le logo d'une série du catalogue, un type de carte, une rareté connue d'une langue ou de
 * l'autre, un Pokémon du Pokédex) : `serveImage` ne sert que ceux-là, et un chemin français ne
 * mène jamais à ce que seule la langue japonaise a.
 */
const UPSTREAMS: {
  path: RegExp
  url: (...parts: string[]) => string
  plausible: (data: Database, ...parts: string[]) => boolean
}[] = [
  {
    // Le scan d'une carte japonaise (`cardScan`) : sa série, son rang, sa taille.
    path: /^\/images\/cards\/([A-Z0-9_-]+)\/(\d{1,4})-(md|hd)\.webp$/,
    url: (set, rank, size) => `${SCANS}/sets_jp/${set}/${rank}.jpg?class=${size}`,
    plausible: plausibleScan('ja'),
  },
  {
    // Celui d'une carte française : le dossier de sa langue (`FR`), jamais celui sans langue
    // (`sets/<série>/<rang>.jpg`), qui n'est pas son scan.
    path: /^\/images\/cards\/fr\/([A-Z0-9_-]+)\/(\d{1,4})-(md|hd)\.webp$/,
    url: (set, rank, size) => `${SCANS}/sets/${set}/FR/${rank}.jpg?class=${size}`,
    plausible: plausibleScan('fr'),
  },
  {
    path: /^\/images\/sets\/([A-Z0-9_-]+)-(md|hd)\.webp$/,
    url: (set, size) => `${ASSETS}/logos_jp/${set}.png?class=${size}`,
    plausible: plausibleLogo('ja'),
  },
  {
    path: /^\/images\/sets\/fr\/([A-Z0-9_-]+)-(md|hd)\.webp$/,
    url: (set, size) => `${ASSETS}/logos/${set}.png?class=${size}`,
    plausible: plausibleLogo('fr'),
  },
  {
    path: /^\/images\/types\/(\d{1,2})\.webp$/,
    url: (type) => `${ASSETS}/types/type_${type}.png?class=md`,
    plausible: (_data, type) => CARD_TYPES.has(Number(type)),
  },
  {
    // Sans langue : les raretés ont les mêmes ids dans les deux, et la même icône chez la source.
    path: /^\/images\/rarities\/(\d{1,3})\.webp$/,
    url: (rarity) => `${ASSETS}/rarete/ids/rarete_${rarity}.png?class=md`,
    plausible: (data, rarity) =>
      data.query('SELECT 1 FROM rarities WHERE id = ?').get(rarity!) !== null,
  },
  {
    path: /^\/images\/species\/(\d{1,4})\.png$/,
    url: (id) => `${SPRITES}/${id}.png`,
    plausible: (_data, id) => within(id!, 1, TOTAL_SPECIES),
  },
  {
    path: /^\/images\/species\/artwork\/(\d{1,4})\.png$/,
    url: (id) => `${SPRITES}/other/official-artwork/${id}.png`,
    plausible: (_data, id) => within(id!, 1, TOTAL_SPECIES),
  },
]

/** Le chemin local connu (`/images/…`) et ses parties ; `null` s'il n'en est pas un. */
function upstreamOf(path: string) {
  for (const upstream of UPSTREAMS) {
    const match = upstream.path.exec(path)
    if (match) return { upstream, parts: match.slice(1) }
  }
  return null
}

/** Le fichier d'un chemin local (`/images/cards/…` → `IMAGES_DIR/cards/…`). */
const imageFile = (path: string) => join(IMAGES_DIR, path.slice('/images/'.length))

/**
 * Copie chez nous l'image d'un chemin local : `true` si elle y est (déjà, ou maintenant), `false`
 * si la source ne l'a pas (404). Une autre erreur (panne, réponse qui n'est pas une image) est
 * levée : réessayer plus tard. Écrite d'un coup : l'API (`serveImage`) ne sert jamais une image à
 * moitié écrite, que le nginx du site garderait ensuite (90 jours sans demande). `force` : copiée
 * même si le fichier existe, qu'elle remplace (le scan d'une carte : son chemin, celui de son rang,
 * a pu être celui d'une autre carte de la série, avant une renumérotation).
 */
export async function mirror(path: string, { force = false } = {}): Promise<boolean> {
  const file = imageFile(path)
  if (!force && (await Bun.file(file).exists())) return true
  // Toujours un chemin connu : bâti par `cardScan`… (tâche `images`).
  const { upstream, parts } = upstreamOf(path)!
  const url = upstream.url(...parts)
  const response = await politeFetch(url)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`)
  if (!response.headers.get('content-type')?.startsWith('image/')) {
    throw new Error(`Pas une image : ${url}`)
  }
  // Un fichier provisoire, renommé quand il est complet ; un nom à part pour chaque copie : deux
  // cartes peuvent avoir le même chemin (le même scan), copiées en même temps par la tâche
  // `images` (deux à la fois), et un nom commun laisserait l'une renommer le fichier pendant que
  // l'autre l'écrit. Retiré si l'écriture échoue (disque plein) : un reste l'aggraverait.
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(temporary, new Uint8Array(await response.arrayBuffer()))
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
  return true
}

/**
 * Retire la copie d'un chemin local, s'il y en a une : le scan d'une carte que la source n'a pas
 * (le fichier de son rang serait celui d'une autre carte).
 */
export const removeImage = (path: string) => rm(imageFile(path), { force: true })

/**
 * Gardées un an par les navigateurs (et par le nginx du site, `proxy_cache`), sans redemande : une
 * image copiée ne change pas, sauf le scan d'une carte dont la source a changé le rang ou la série
 * (`jobs/images.ts` le recopie). Ce cas, jamais vu (aucun rang changé du 19 au 24 octobre 2026),
 * est accepté : un navigateur qui avait l'ancien scan de ce chemin le garde jusqu'à ce que son
 * cache se vide, le nginx du site jusqu'à son prochain déploiement (son cache, dans son conteneur,
 * y est vidé).
 */
const IMAGE_HEADERS = { 'Cache-Control': 'public, max-age=31536000, immutable' }

/**
 * `/v1/images/…` : la copie de l'image, sinon 404, sans rien télécharger (la tâche `images` les
 * copie toutes d'avance ; le site montre alors la carte de substitution). Seulement un chemin
 * plausible (`UPSTREAMS`).
 */
export async function serveImage(data: Database, request: Request) {
  const path = new URL(request.url).pathname.replace(/^\/v1/, '')
  const known = upstreamOf(path)
  if (!known || !known.upstream.plausible(data, ...known.parts)) return notFound()
  const file = Bun.file(imageFile(path))
  if (!(await file.exists())) return notFound()
  return new Response(file, { headers: IMAGE_HEADERS })
}
