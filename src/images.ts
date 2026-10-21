/**
 * Les images, copiées chez nous (`IMAGES_DIR`, le volume `images` sur le VPS), que l'API sert à
 * `/v1/images/…` (le site les rend à `/images/…`, gardées en cache par son nginx) : chez Pokécardex
 * (avec son accord, qui demande de les héberger chez nous), les cartes, le logo japonais de chaque
 * série et les icônes des types et des raretés ; chez PokéAPI, les sprites et illustrations des
 * Pokémon. Leurs chemins sont neutres (`cardScan`…) : seule la table `UPSTREAMS` connaît
 * l'adresse d'origine de chacun. Seuls ces chemins-là sont copiés : l'API n'est pas un relais
 * ouvert.
 */

import type { Database } from 'bun:sqlite'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CARD_TYPES } from '@/config/catalog'
import { TOTAL_SPECIES } from '@/config/pokedex'
import { WEEK } from '@/lib/time'
import { DATA_DIR } from './db'
import { journal } from './journal'
import { politeFetch, quickFetch } from './lib/net'
import { notFound } from './snapshots'

const IMAGES_DIR = process.env.IMAGES_DIR ?? join(DATA_DIR, 'images')

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'
/** Les scans des cartes japonaises de Pokécardex, en WebP (`class`). */
const SCANS = 'https://pokecardex-scans.b-cdn.net/sets_jp'
/** Les images du site de Pokécardex, en WebP (`class`) : logos, icônes. */
const ASSETS = 'https://pokecardex.b-cdn.net/assets/images'

/* Les chemins des images (le site les rend à son adresse, `/images/…`) : sans nom de source */

/**
 * Le scan d'une carte : le code de sa série et son rang (celui du catalogue), en deux tailles, `md`
 * pour les grilles, `hd` pour la fiche.
 */
export const cardScan = (set: string, rank: number | string, size: 'md' | 'hd') =>
  `/images/cards/${set}/${rank}-${size}.webp`

/** Le logo japonais d'une série, en deux tailles : `md` pour la liste, `hd` en tête de page. */
export const setLogo = (set: string, size: 'md' | 'hd') => `/images/sets/${set}-${size}.webp`

/** L'icône d'un type de carte (`CARD_TYPES`). */
export const typeIcon = (type: number) => `/images/types/${type}.webp`

/** L'icône d'une rareté (« SAR », ●…). */
export const rarityIcon = (rarity: number) => `/images/rarities/${rarity}.webp`

/** Le sprite et l'illustration officielle d'un Pokémon. */
export const spriteUrl = (id: number) => `/images/species/${id}.png`
export const artworkUrl = (id: number) => `/images/species/artwork/${id}.png`

/** Un nombre lu dans un chemin. */
const within = (value: string, min: number, max: number) =>
  Number(value) >= min && Number(value) <= max

/**
 * Les chemins locaux connus : l'adresse d'origine de chacun, et s'il est plausible (une série du
 * catalogue et un numéro d'image jusqu'au plus grand des siens, le logo d'une série du catalogue,
 * un type de carte, une rareté connue, un Pokémon du Pokédex) : des chemins inventés ne font pas
 * solliciter les sources.
 */
const UPSTREAMS: {
  path: RegExp
  url: (...parts: string[]) => string
  plausible: (data: Database, ...parts: string[]) => boolean
}[] = [
  {
    // Le scan d'une carte (`cardScan`) : sa série, son rang, sa taille.
    path: /^\/images\/cards\/([A-Z0-9_-]+)\/(\d{1,4})-(md|hd)\.webp$/,
    url: (set, number, size) => `${SCANS}/${set}/${number}.jpg?class=${size}`,
    plausible: (data, set, number) => {
      const { max } = data
        .query('SELECT MAX(sort) AS max FROM cards WHERE set_id = ?')
        .get(set!) as {
        max: number | null
      }
      return max !== null && within(number!, 1, max)
    },
  },
  {
    path: /^\/images\/sets\/([A-Z0-9_-]+)-(md|hd)\.webp$/,
    url: (set, size) => `${ASSETS}/logos_jp/${set}.png?class=${size}`,
    plausible: (data, set) => data.query('SELECT 1 FROM sets WHERE id = ?').get(set!) !== null,
  },
  {
    path: /^\/images\/types\/(\d{1,2})\.webp$/,
    url: (type) => `${ASSETS}/types/type_${type}.png?class=md`,
    plausible: (_data, type) => CARD_TYPES.has(Number(type)),
  },
  {
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
 * moitié écrite, que le nginx du site garderait ensuite (90 jours sans demande).
 * `quick` : une page l'attend (copie à la demande), sans la pause de la tâche `images`, 15 s au
 * plus.
 */
export async function mirror(path: string, { quick = false } = {}): Promise<boolean> {
  const file = imageFile(path)
  if (await Bun.file(file).exists()) return true
  // Toujours un chemin connu : bâti par `cardScan`… (tâche `images`), ou reconnu par `serveImage`.
  const { upstream, parts } = upstreamOf(path)!
  const url = upstream.url(...parts)
  const response = quick ? await quickFetch(url) : await politeFetch(url)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`)
  if (!response.headers.get('content-type')?.startsWith('image/')) {
    throw new Error(`Pas une image : ${url}`)
  }
  // Un nom à part : le serveur et la tâche `images` peuvent copier la même image en même temps.
  // Retiré si l'écriture échoue (disque plein) : un reste l'aggraverait.
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
 * Gardées un an par les navigateurs (et par le nginx du site, `proxy_cache`), sans redemande : une
 * image copiée ne change jamais (`mirror` ne réécrit pas un fichier qui existe).
 */
const IMAGE_HEADERS = { 'Cache-Control': 'public, max-age=31536000, immutable' }
/** Les images que la source n'a pas, et quand on l'a appris : pas redemandées avant une semaine. */
const misses = new Map<string, number>()
/** Les copies en cours : deux demandes de la même image ne la téléchargent qu'une fois. */
const copies = new Map<string, Promise<boolean>>()

/**
 * Les copies à la demande menées en même temps, au plus : l'API n'en télécharge que 4 à la fois ;
 * les autres attendent leur tour. Une
 * place libérée passe directement à la suivante qui attend : une nouvelle demande ne peut pas la
 * prendre entre-temps (on en mènerait 5).
 */
const MAX_COPIES = 4
let copying = 0
const queued: (() => void)[] = []

async function inTurn<T>(task: () => Promise<T>) {
  if (copying < MAX_COPIES) copying++
  else await new Promise<void>((resolve) => queued.push(resolve))
  try {
    return await task()
  } finally {
    const next = queued.shift()
    if (next) next()
    else copying--
  }
}

/**
 * `/v1/images/…` : la copie de l'image, sinon copiée à la demande — une référence saisie hors du
 * catalogue, une image que la tâche `images` n'a pas encore copiée. Seulement un chemin plausible
 * (`UPSTREAMS`).
 */
export async function serveImage(data: Database, request: Request) {
  const path = new URL(request.url).pathname.replace(/^\/v1/, '')
  const known = upstreamOf(path)
  if (!known || !known.upstream.plausible(data, ...known.parts)) return notFound()
  const file = Bun.file(imageFile(path))
  if (await file.exists()) return new Response(file, { headers: IMAGE_HEADERS })
  if (Date.now() - (misses.get(path) ?? 0) < WEEK) return notFound()

  let copy = copies.get(path)
  if (!copy) {
    copy = inTurn(() => mirror(path, { quick: true })).finally(() => copies.delete(path))
    copies.set(path, copy)
  }
  try {
    if (await copy) return new Response(Bun.file(imageFile(path)), { headers: IMAGE_HEADERS })
    // Une liste bornée : des chemins inventés ne la font pas grossir sans fin.
    if (misses.size > 50_000) misses.clear()
    misses.set(path, Date.now())
    return notFound()
  } catch (error) {
    journal({
      topic: 'images',
      level: 'warn',
      message: 'Image non copiée',
      details: { image: path, raison: error instanceof Error ? error.message : String(error) },
    })
    return new Response(null, { status: 502 })
  }
}
