/**
 * `/v1/images/…` : les images copiées d'avance par la tâche `images` (`ingest/images.ts`), servies
 * depuis R2 (`images/…`), sinon 404, sans rien télécharger (le site montre alors la carte de
 * substitution). Seulement un chemin plausible (`IMAGE_PATHS`) : une série du catalogue, dans sa
 * langue, et un rang jusqu'au plus grand des siens ; le logo d'une série du catalogue ; un type de
 * carte ; une rareté connue d'une langue ou de l'autre ; un Pokémon du Pokédex. Un chemin français
 * ne mène jamais à ce que seule la langue japonaise a.
 */

import { env } from 'cloudflare:workers'
import type { Context } from 'hono'
import { CARD_TYPES } from '@/config/catalog'
import { TOTAL_SPECIES } from '@/config/pokedex'
import type { CardLanguage } from '@/contract'
import { imagePathOf, type ImageKind } from '@/lib/image-paths'
import { MINUTE } from '@/lib/time'
import { notFound } from './snapshots'

/** Un nombre lu dans un chemin. */
const within = (value: string, min: number, max: number) =>
  Number(value) >= min && Number(value) <= max

/**
 * Ce que gardent en mémoire les contrôles des chemins, pour chaque exemplaire du Worker : une page
 * du catalogue demande des dizaines d'images d'une même série, chacune attendait sinon sa requête
 * D1. Relu au-delà : une série ou une rareté que vient d'ajouter une tâche est servie au plus
 * 10 min plus tard (ses images, copiées ensuite, ne sont pas encore là), et une série retirée
 * l'est encore jusqu'à 10 min.
 */
const KEPT = 10 * MINUTE

/**
 * Le plus grand rang des cartes de chaque série lue (`ja|SVP`), et quand. Seulement une série qui a
 * des cartes : un chemin inventé n'y reste pas, il est relu à chaque fois.
 */
const maxRanks = new Map<string, { max: number; at: number }>()

/** Un scan est plausible jusqu'au plus grand rang des cartes de la série, dans cette langue. */
const plausibleScan = (lang: CardLanguage) => async (set: string, rank: string) => {
  const key = `${lang}|${set}`
  let known = maxRanks.get(key)
  if (!known || Date.now() - known.at >= KEPT) {
    const row = await env.DB.prepare(
      'SELECT MAX(sort) AS max FROM cards WHERE lang = ? AND set_id = ?',
    )
      .bind(lang, set)
      .first<{ max: number | null }>()
    known = row?.max == null ? undefined : { max: row.max, at: Date.now() }
    if (known) maxRanks.set(key, known)
    else maxRanks.delete(key)
  }
  return known !== undefined && within(rank, 1, known.max)
}

/** Les raretés connues des deux langues (quelques dizaines), et quand elles ont été lues. */
let rarities: { ids: Set<number>; at: number } | undefined

/** Une rareté connue d'une langue ou de l'autre. */
async function knownRarity(rarity: string) {
  if (!rarities || Date.now() - rarities.at >= KEPT) {
    const { results } = await env.DB.prepare('SELECT DISTINCT id FROM rarities').all<{
      id: number
    }>()
    rarities = { ids: new Set(results.map(({ id }) => id)), at: Date.now() }
  }
  return rarities.ids.has(Number(rarity))
}

/** Un logo est plausible pour une série de cette langue. */
const plausibleLogo = (lang: CardLanguage) => async (set: string) =>
  (await env.DB.prepare('SELECT 1 FROM sets WHERE lang = ? AND id = ?').bind(lang, set).first()) !==
  null

const PLAUSIBLE: Record<ImageKind, (...parts: string[]) => boolean | Promise<boolean>> = {
  cardJa: plausibleScan('ja'),
  cardFr: plausibleScan('fr'),
  logoJa: plausibleLogo('ja'),
  logoFr: plausibleLogo('fr'),
  type: (type) => CARD_TYPES.has(Number(type)),
  // Sans langue : les raretés ont les mêmes ids dans les deux, et la même icône chez la source.
  rarity: knownRarity,
  sprite: (id) => within(id, 1, TOTAL_SPECIES),
  artwork: (id) => within(id, 1, TOTAL_SPECIES),
}

/**
 * Gardées un an par les navigateurs, sans redemande : une image copiée ne change pas, sauf le scan
 * d'une carte dont la source a changé le rang ou la série (`ingest/images.ts` le recopie). Ce cas,
 * jamais vu (aucun rang changé du 19 au 24 octobre 2026), est accepté : un navigateur qui avait
 * l'ancien scan de ce chemin le garde jusqu'à ce que son cache se vide.
 */
const CACHE = 'public, max-age=31536000, immutable'

export async function serveImage(c: Context) {
  const path = c.req.path.replace(/^\/v1/, '')
  const known = imagePathOf(path)
  if (!known || !(await PLAUSIBLE[known.kind](...known.parts))) return notFound()
  const object = await env.FILES.get(path.slice(1))
  if (!object) return notFound()
  return new Response(object.body, {
    headers: {
      'Cache-Control': CACHE,
      'Content-Type': path.endsWith('.png') ? 'image/png' : 'image/webp',
      ETag: object.httpEtag,
    },
  })
}
