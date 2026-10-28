/**
 * Tâche `images`, à la demande (après le catalogue : `bun run ingest cards`) : copie d'avance dans
 * R2 (`images/…`) toutes les images que montre le site : l'API n'en télécharge jamais elle-même
 * (`worker/images.ts`). Pokécardex prête les siennes à condition qu'elles soient hébergées chez
 * nous, jamais affichées depuis ses serveurs. Leurs chemins sont neutres (`lib/image-paths.ts`) :
 * seule la table `UPSTREAMS`, ici, connaît l'adresse d'origine de chacun.
 * - D'abord, chaque série du catalogue, japonaise et française : son logo chez Pokécardex, en deux
 *   tailles, ou aucun (noté : `sets.logo`, cherché de nouveau chaque semaine) ; les icônes des types
 *   et des raretés (celles des cartes des deux langues, les mêmes pour un même id).
 * - Les 1 025 Pokémon : sprite et illustration officielle (PokéAPI).
 * - Chaque carte du catalogue, dans ses deux langues : son scan chez Pokécardex, en deux tailles
 *   (`md` pour les grilles, `hd` pour la fiche), ou aucun. Le résultat est noté (`cards.image`) :
 *   l'app sait d'avance quelle carte n'a pas d'image. Une carte sans scan est recherchée chaque
 *   semaine (Pokécardex en ajoute).
 * Seules les images qui manquent sont téléchargées, et le scan de chaque carte cherchée (même s'il
 * est déjà copié : après une renumérotation de sa série, celui de son rang est le scan d'une autre
 * carte ; une carte sans ses deux scans chez la source n'en garde aucun), deux à la fois :
 * Pokécardex prête ses images, on ne l'inonde pas. Une carte que le catalogue déplace pendant sa
 * copie n'est pas notée : elle reste à chercher, à sa nouvelle place. Par étapes (50 séries, 100
 * Pokémon, 50 cartes) : le premier passage (environ 3 Go) prend quelques heures, et une étape en
 * échec est reprise seule. Une image en erreur (panne, réponse qui n'est pas une image) n'empêche
 * pas les autres : rien n'est noté pour elle, la tâche échoue à la fin pour être relancée, et
 * l'image est redemandée. À la 20e erreur, la source est sans doute en panne : la tâche s'arrête là.
 * En fin de tâche, même arrêtée, les réponses du catalogue sont recalculées (`saveCatalog`).
 */

import { env } from 'cloudflare:workers'
import { CARD_TYPES } from '@/config/catalog'
import { SPECIES_IDS } from '@/config/pokedex'
import type { CardLanguage } from '@/contract'
import {
  artworkUrl,
  cardScan,
  imagePathOf,
  rarityIcon,
  setLogo,
  spriteUrl,
  typeIcon,
  type ImageKind,
} from '@/lib/image-paths'
import { WEEK } from '@/lib/time'
import { journal, plural, reasonOf } from '../journal'
import { saveCatalog } from './catalog'
import { mapPool, politeFetch } from './net'
import type { Step } from './workflow'

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'
/** Les scans des cartes de Pokécardex, en WebP (`class`) : `sets_jp/` pour les japonaises. */
const SCANS = 'https://pokecardex-scans.b-cdn.net'
/** Les images du site de Pokécardex, en WebP (`class`) : logos, icônes. */
const ASSETS = 'https://pokecardex.b-cdn.net/assets/images'

/** L'adresse d'origine de chaque sorte de chemin (`IMAGE_PATHS`). */
const UPSTREAMS: Record<ImageKind, (...parts: string[]) => string> = {
  // Le scan d'une carte japonaise (`cardScan`) : sa série, son rang, sa taille.
  cardJa: (set, rank, size) => `${SCANS}/sets_jp/${set}/${rank}.jpg?class=${size}`,
  // Celui d'une carte française : le dossier de sa langue (`FR`), jamais celui sans langue
  // (`sets/<série>/<rang>.jpg`), qui n'est pas son scan.
  cardFr: (set, rank, size) => `${SCANS}/sets/${set}/FR/${rank}.jpg?class=${size}`,
  logoJa: (set, size) => `${ASSETS}/logos_jp/${set}.png?class=${size}`,
  logoFr: (set, size) => `${ASSETS}/logos/${set}.png?class=${size}`,
  type: (type) => `${ASSETS}/types/type_${type}.png?class=md`,
  // Sans langue : les raretés ont les mêmes ids dans les deux, et la même icône chez la source.
  rarity: (rarity) => `${ASSETS}/rarete/ids/rarete_${rarity}.png?class=md`,
  sprite: (id) => `${SPRITES}/${id}.png`,
  artwork: (id) => `${SPRITES}/other/official-artwork/${id}.png`,
}

/** L'adresse d'origine d'un chemin (`/images/…`), toujours connu : bâti par `cardScan`… */
function upstreamOf(path: string) {
  const { kind, parts } = imagePathOf(path)!
  return UPSTREAMS[kind](...parts)
}

/** La clé R2 d'une image (`/images/cards/…` → `images/cards/…`). */
const keyOf = (path: string) => path.slice(1)

/**
 * Copie dans R2 l'image d'un chemin : `true` si elle y est (déjà, ou maintenant), `false` si la
 * source ne l'a pas (404). Une autre erreur (panne, réponse qui n'est pas une image) est levée :
 * réessayer plus tard. `force` : copiée même si elle y est, qu'elle remplace (le scan d'une carte :
 * son chemin, celui de son rang, a pu être celui d'une autre carte de la série, avant une
 * renumérotation).
 */
export async function mirror(path: string, { force = false } = {}) {
  if (!force && (await env.FILES.head(keyOf(path)))) return true
  const url = upstreamOf(path)
  const response = await politeFetch(url)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`)
  const contentType = response.headers.get('content-type')
  if (!contentType?.startsWith('image/')) throw new Error(`Pas une image : ${url}`)
  await env.FILES.put(keyOf(path), await response.arrayBuffer(), {
    httpMetadata: { contentType },
  })
  return true
}

/** À la 20e erreur, la source est sans doute en panne : on ne la sollicite pas davantage. */
const MAX_FAILURES = 20

/**
 * Ce qu'une étape a copié : son avancée (`after` : la dernière ligne traitée), et les chemins en
 * erreur.
 */
interface Batch<C> {
  after: C | null
  failed: string[]
  found: number
}

/**
 * Copie les images de l'étape (`copy`), deux à la fois : une image en erreur est notée et passée
 * (rien n'est noté pour elle en base), les autres continuent.
 */
function copier(failed: string[]) {
  return async (path: string, force = false) => {
    try {
      return await mirror(path, { force })
    } catch (error) {
      failed.push(path)
      journal({
        topic: 'tâches',
        level: 'warn',
        message: 'Image en erreur',
        details: { chemin: path, raison: reasonOf(error) },
      })
      return null
    }
  }
}

/** Les logos de 50 séries après `after` : jamais cherchés, ou absents depuis plus d'une semaine. */
async function logos(after: [string, string] | null): Promise<Batch<[string, string]>> {
  const weekAgo = new Date(Date.now() - WEEK).toISOString()
  const { results } = await env.DB.prepare(
    `SELECT lang, id FROM sets
     WHERE EXISTS (SELECT 1 FROM cards WHERE cards.lang = sets.lang AND cards.set_id = sets.id)
       AND (logo IS NULL OR (logo = 'none' AND logo_checked < ?))
       AND (lang, id) > (?, ?)
     ORDER BY lang, id LIMIT 50`,
  )
    .bind(weekAgo, after?.[0] ?? '', after?.[1] ?? '')
    .all<{ lang: CardLanguage; id: string }>()
  const failed: string[] = []
  const copy = copier(failed)
  let found = 0
  const write = env.DB.prepare(
    'UPDATE sets SET logo = ?, logo_checked = ? WHERE lang = ? AND id = ?',
  )
  const done = await mapPool(results, 2, async ({ lang, id }) => {
    const copied = (await copy(setLogo(lang, id, 'md'))) && (await copy(setLogo(lang, id, 'hd')))
    if (copied) found++
    return copied === null
      ? null
      : write.bind(copied ? 'pokecardex' : 'none', new Date().toISOString(), lang, id)
  })
  const writes = done.filter((statement) => statement !== null)
  if (writes.length) await env.DB.batch(writes)
  const last = results.at(-1)
  return { after: last ? [last.lang, last.id] : null, failed, found }
}

/** Les icônes des types et des raretés (celles des cartes des deux langues, une par id). */
async function icons(): Promise<Batch<null>> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT rarities.id FROM rarities
     JOIN cards ON cards.lang = rarities.lang AND cards.rarity = rarities.id`,
  ).all<{ id: number }>()
  const paths = [...CARD_TYPES].map(typeIcon).concat(results.map(({ id }) => rarityIcon(id)))
  const failed: string[] = []
  const copied = await mapPool(paths, 2, copier(failed))
  return { after: null, failed, found: copied.filter(Boolean).length }
}

/** Le sprite et l'illustration de ces Pokémon. */
async function species(ids: readonly number[]): Promise<Batch<null>> {
  const failed: string[] = []
  const copy = copier(failed)
  const copied = await mapPool(ids, 2, async (id) => {
    await copy(spriteUrl(id))
    return copy(artworkUrl(id))
  })
  return { after: null, failed, found: copied.filter(Boolean).length }
}

/**
 * Les scans de 50 cartes après `after` : jamais cherchées (dont celles que le catalogue remet à
 * chercher : leur série ou leur rang a changé), ou sans scan cherché il y a plus d'une semaine.
 */
async function scans(after: [string, number] | null): Promise<Batch<[string, number]>> {
  const weekAgo = new Date(Date.now() - WEEK).toISOString()
  const { results } = await env.DB.prepare(
    `SELECT lang, id, set_id AS 'set', sort FROM cards
     WHERE (image IS NULL OR (image = 'none' AND image_checked < ?)) AND (lang, id) > (?, ?)
     ORDER BY lang, id LIMIT 50`,
  )
    .bind(weekAgo, after?.[0] ?? '', after?.[1] ?? 0)
    .all<{ lang: CardLanguage; id: number; set: string; sort: number }>()
  // Seulement si la carte est encore à cette place : le catalogue a pu la déplacer pendant la
  // copie (elle reste alors à chercher, à sa nouvelle place).
  const write = env.DB.prepare(
    `UPDATE cards SET image = ?, image_checked = ?
     WHERE lang = ? AND id = ? AND set_id = ? AND sort = ?`,
  )
  const failed: string[] = []
  const copy = copier(failed)
  let found = 0
  const done = await mapPool(results, 2, async ({ lang, id, set, sort }) => {
    // Chaque scan cherché est recopié, même s'il est déjà copié, et une carte sans ses deux scans
    // chez la source n'en garde aucun : les chemins suivent le rang, et après une renumérotation de
    // la série (une carte arrivée, une carte déplacée), le scan de ce rang est celui de la carte qui
    // l'avait. Gardé, il serait servi pour celle-ci.
    const [md, hd] = [cardScan(lang, set, sort, 'md'), cardScan(lang, set, sort, 'hd')]
    const copied = (await copy(md, true)) && (await copy(hd, true))
    if (copied === false) await env.FILES.delete([keyOf(md), keyOf(hd)])
    if (copied) found++
    // En erreur, rien n'est noté : la carte est cherchée de nouveau au prochain passage.
    return copied === null
      ? null
      : write.bind(copied ? 'pokecardex' : 'none', new Date().toISOString(), lang, id, set, sort)
  })
  const writes = done.filter((statement) => statement !== null)
  if (writes.length) await env.DB.batch(writes)
  const last = results.at(-1)
  return { after: last ? [last.lang, last.id] : null, failed, found }
}

/** Les Pokémon copiés par étape. */
const SPECIES_PER_STEP = 100

export async function images(step: Step) {
  const failed: string[] = []
  let found = 0
  /** Une étape : ce qu'elle a trouvé, ses erreurs ; à la 20e, la tâche s'arrête là. */
  const add = <C>(batch: Batch<C>) => {
    failed.push(...batch.failed)
    found += batch.found
    if (failed.length >= MAX_FAILURES) {
      throw new Error(`${failed.length} images en erreur : la source est sans doute en panne`)
    }
    return batch.after
  }
  try {
    let set: [string, string] | null = null
    for (let page = 1; ; page++) {
      const after: [string, string] | null = set
      set = add(await step(`logos ${page}`, () => logos(after)))
      if (!set) break
    }
    add(await step('icônes', icons))
    for (let from = 0; from < SPECIES_IDS.length; from += SPECIES_PER_STEP) {
      const ids = SPECIES_IDS.slice(from, from + SPECIES_PER_STEP)
      add(await step(`Pokémon ${ids[0]} à ${ids.at(-1)}`, () => species(ids)))
    }
    let card: [string, number] | null = null
    for (let page = 1; ; page++) {
      const after: [string, number] | null = card
      card = add(await step(`scans ${page}`, () => scans(after)))
      if (!card) break
    }
    journal({
      topic: 'tâches',
      level: 'ok',
      message: 'Images copiées',
      details: { trouvées: found },
    })
  } finally {
    await saveCatalog(step)
  }
  if (failed.length) {
    const some = failed.slice(0, 5).join(', ')
    const count = plural(
      failed.length,
      'image en erreur, redemandée',
      'images en erreur, redemandées',
    )
    throw new Error(`${count} au prochain passage (${some})`)
  }
}
