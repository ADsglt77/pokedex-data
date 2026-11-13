/**
 * `/v1/images/…` : les images, servies depuis R2, sinon 404, sans rien télécharger (le site montre
 * alors la carte de substitution). Seulement un chemin de la forme exacte de son gabarit
 * (`imagePathOf`) :
 * - le scan d'une carte (`/images/cards/<langue>/<série>/<carte>-<md|hd>.webp`) et le logo d'une
 *   série (`/images/sets/<langue>/<série>.webp`), que copie l'importateur `pokecodex-importer`
 *   (`IMPORTS`, `cards/<langue>/<série>/…`, lu seulement) : `hd`, l'image de TCGdex
 *   (`<carte>.webp`) ; `md`, sa petite image (`<carte>.low.webp`), ou la grande tant que
 *   l'importateur ne l'a pas copiée ; le logo, `_logo.webp`. La langue est dans le chemin comme
 *   dans la clé : un chemin français ne mène qu'à une image française ;
 * - le sprite et l'illustration d'un Pokémon du Pokédex (`FILES`, `images/species/…`, tâche
 *   `sprites`) : l'illustration en WebP, ou son PNG tant que le WebP n'est pas converti.
 */

import { env } from 'cloudflare:workers'
import type { Context } from 'hono'
import { TOTAL_SPECIES } from '@/config/pokedex'
import { imagePathOf } from '@/lib/image-paths'
import { notFound } from './snapshots'

/** Un Pokémon du Pokédex : un numéro de 1 à 1 025. */
const isSpecies = (id: string) => Number(id) >= 1 && Number(id) <= TOTAL_SPECIES

/** Le premier objet trouvé parmi ces clés d'un bucket, et sa clé ; `null` si aucun n'y est. */
async function first(bucket: R2Bucket, ...keys: string[]) {
  for (const key of keys) {
    const object = await bucket.get(key)
    if (object) return { key, object }
  }
  return null
}

/** L'image d'un chemin servi (`imagePathOf`) : son objet R2 et sa clé ; `null` sans image. */
function imageOf(path: string) {
  const known = imagePathOf(path)
  if (!known) return null
  const { kind, parts } = known
  if (kind === 'card') {
    const [lang, set, card, size] = parts
    const key = `cards/${lang}/${set}/${card}`
    return size === 'md'
      ? first(env.IMPORTS, `${key}.low.webp`, `${key}.webp`)
      : first(env.IMPORTS, `${key}.webp`)
  }
  if (kind === 'logo') return first(env.IMPORTS, `cards/${parts[0]}/${parts[1]}/_logo.webp`)
  if (!isSpecies(parts[0]!)) return null
  if (kind === 'artwork') {
    return first(
      env.FILES,
      `images/species/artwork/${parts[0]}.webp`,
      `images/species/artwork/${parts[0]}.png`,
    )
  }
  return first(env.FILES, path.slice(1))
}

/**
 * Gardées un an par les navigateurs, sans redemande : l'importateur ne remplace jamais une image
 * copiée. Sauf une image de repli, qui changera : la grande image servie pour le scan `md` tant que
 * l'importateur n'a pas copié la petite, le PNG d'une illustration tant que son WebP n'est pas
 * converti. Gardée un jour seulement : immuable, elle resterait un an dans chaque navigateur, et la
 * petite image ne serait jamais vue.
 */
const CACHE = 'public, max-age=31536000, immutable'
const FALLBACK_CACHE = 'public, max-age=86400'

/** L'objet servi n'est pas celui que nomme le chemin, mais son repli (`imageOf`). */
const isFallback = (path: string, key: string) =>
  (path.endsWith('-md.webp') && !key.endsWith('.low.webp')) ||
  (path.endsWith('.webp') && key.endsWith('.png'))

export async function serveImage(c: Context) {
  const path = c.req.path.replace(/^\/v1/, '')
  const found = await imageOf(path)
  if (!found) return notFound()
  return new Response(found.object.body, {
    headers: {
      'Cache-Control': isFallback(path, found.key) ? FALLBACK_CACHE : CACHE,
      'Content-Type': found.key.endsWith('.png') ? 'image/png' : 'image/webp',
      ETag: found.object.httpEtag,
    },
  })
}
