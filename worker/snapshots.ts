/**
 * Les réponses de l'API qui ne se lisent pas ligne à ligne en base, et le 404 sans corps de toute
 * l'API (`notFound`) :
 * - les volumineuses (catalogue, espèces), calculées en fin de tâche d'ingestion (`saveSnapshot`),
 *   dans R2 (`snapshots/<nom>.json`, `serveSnapshot`) : servies telles quelles ;
 * - celles calculées à la demande, dont l'ETag se connaît d'avance (`serveTagged`) : celles tirées
 *   des prix.
 * Celui qui a déjà la version du moment (`If-None-Match`) reçoit un 304, sans corps.
 */

import { env } from 'cloudflare:workers'

/**
 * La forme des réponses calculées à la demande (`serveTagged` : celles tirées des prix, et les
 * historiques ; `contract.ts`), dans leur ETag : à augmenter quand l'une d'elles change de forme,
 * un client ne garde jamais une réponse d'une ancienne forme. Les espèces et le catalogue, gardés
 * dans R2 tels qu'écrits, n'en dépendent pas : leur changement de forme se fait en trois temps
 * (`../pokedex/docs/deploiement.md`). 2 : les prix rendent une clé par carte
 * demandée, `null` sans prix (octobre 2026). 3 : le prix d'une carte suit la règle de Pokécardex,
 * et son troisième nombre est son prix d'il y a 30 jours (octobre 2026).
 */
const FORMAT = 3

/** 404, sans corps ni cache : ce qui manque peut arriver (une tâche, une image copiée). */
export const notFound = () =>
  new Response(null, { status: 404, headers: { 'Cache-Control': 'no-cache' } })

/**
 * L'ETag que le client a déjà (`If-None-Match`) ; un relais qui compresse la réponse l'affaiblit
 * en `W/"…"` : c'est le même.
 */
const sentEtag = (request: Request) => request.headers.get('if-none-match')?.replace(/^W\//, '')

/**
 * Un ETag tiré d'un texte : les 12 premiers octets de son empreinte SHA-256 (la même règle que
 * `etagOf`, `../pokedex/worker/vitrine.ts`).
 */
async function etagOf(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return `"${hexOf(digest).slice(0, 24)}"`
}

/** Une empreinte en hexadécimal. */
const hexOf = (digest: ArrayBuffer) =>
  [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Une réponse JSON calculée à la demande (`read` : son texte, les historiques étant assemblés en
 * texte), dont l'ETag se tire de ce dont elle dépend (`version` : le jour des prix et ce qui est
 * demandé, par exemple), connu sans la calculer : 304 sans rien lire si le client l'a déjà ; 404 si
 * `read` ne rend rien.
 */
export async function serveTagged(
  request: Request,
  version: string,
  read: () => Promise<string | null>,
) {
  const etag = await etagOf(`${FORMAT}|${version}`)
  const headers = { 'Cache-Control': 'no-cache', ETag: etag }
  if (sentEtag(request) === etag) return new Response(null, { status: 304, headers })
  const text = await read()
  if (text === null) return notFound()
  return new Response(text, { headers: { ...headers, 'Content-Type': 'application/json' } })
}

/** La clé R2 d'une réponse calculée. */
const snapshotKey = (name: string) => `snapshots/${name}.json`

/**
 * Une réponse calculée en fin de tâche (`name` : `species`, `catalog/sets/SV2A`…), son ETag celui
 * de R2 ; 404 tant que sa tâche n'est jamais passée.
 */
export async function serveSnapshot(name: string, request: Request) {
  const sent = sentEtag(request)
  const object = await env.FILES.get(snapshotKey(name), {
    onlyIf: sent ? { etagDoesNotMatch: sent.replaceAll('"', '') } : undefined,
  })
  if (!object) return notFound()
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ETag: object.httpEtag,
  }
  // Sans corps : le client a déjà celle-là.
  if (!('body' in object)) return new Response(null, { status: 304, headers })
  return new Response(object.body, { headers })
}

/**
 * Enregistre une réponse calculée par une tâche (`name` : `species`, `catalog/sets/SV2A`…),
 * seulement si elle a changé : son MD5 comparé à l'ETag de R2 (celui d'un objet écrit d'un coup).
 * Un passage `cards` en recalcule environ 5 500, deux fois, presque toutes inchangées : une
 * lecture de leur en-tête plutôt qu'une écriture.
 */
export async function saveSnapshot(name: string, data: unknown) {
  const text = new TextEncoder().encode(JSON.stringify(data))
  const md5 = hexOf(await crypto.subtle.digest('MD5', text))
  if ((await env.FILES.head(snapshotKey(name)))?.etag === md5) return
  await env.FILES.put(snapshotKey(name), text, {
    httpMetadata: { contentType: 'application/json' },
  })
}

/** Retire les réponses calculées dont le nom commence par `prefix`, sauf celles de `kept`. */
export async function removeSnapshots(prefix: string, kept: Set<string>) {
  let cursor: string | undefined
  do {
    const listed = await env.FILES.list({ prefix: `snapshots/${prefix}`, cursor })
    const stale = listed.objects
      .map(({ key }) => key)
      .filter((key) => !kept.has(key.slice('snapshots/'.length, -'.json'.length)))
    if (stale.length) await env.FILES.delete(stale)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}
