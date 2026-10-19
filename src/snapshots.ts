/**
 * Les réponses volumineuses de l'API (catalogue, espèces) : calculées une fois en fin de tâche
 * d'ingestion et gardées compressées deux fois (gzip et Brotli, un quart à un tiers plus petit),
 * avec leur ETag. L'API sert la ligne telle quelle, dans la compression que le navigateur accepte :
 * celui qui a déjà la version du jour reçoit un 304, sans corps (lu sans elle). Aussi, pour toute
 * l'API : le 404 sans corps (`notFound`) et une réponse calculée à la demande dont l'ETag se
 * connaît d'avance (`serveTagged`).
 */

import type { Database } from 'bun:sqlite'
import { brotliCompressSync, constants } from 'node:zlib'
import { API_FORMAT } from '@/config/api'

/**
 * Enregistre la réponse, avec son ETag, qui ne change qu'avec son contenu. Inchangée (même ETag,
 * déjà compressée en Brotli), rien n'est recompressé : la compression la plus forte coûte, et la
 * tâche refait ses réponses à chaque passage.
 */
export function saveSnapshot(db: Database, name: string, data: unknown) {
  const text = JSON.stringify(data)
  const etag = `"${Bun.hash(text).toString(36)}"`
  const known = db
    .query('SELECT 1 FROM snapshots WHERE name = ? AND etag = ? AND brotli IS NOT NULL')
    .get(name, etag)
  if (known) return
  const brotli = brotliCompressSync(text, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: text.length,
    },
  })
  db.query(
    `INSERT INTO snapshots (name, etag, body, brotli) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET etag = excluded.etag, body = excluded.body,
                                      brotli = excluded.brotli`,
  ).run(name, etag, Bun.gzipSync(text, { level: 9 }), brotli)
}

/** 404, sans corps ni cache : ce qui manque peut arriver (une tâche, une image copiée). */
export const notFound = () =>
  new Response(null, { status: 404, headers: { 'Cache-Control': 'no-cache' } })

/**
 * Le navigateur a-t-il déjà cette version (`If-None-Match`) ? Un relais (Cloudflare) peut affaiblir
 * l'ETag en `W/"…"` : c'est le même.
 */
const matchesEtag = (request: Request, etag: string) =>
  request.headers.get('if-none-match')?.replace(/^W\//, '') === etag

/**
 * La forme des réponses calculées à la demande (`API_FORMAT`) : changée avec elle, leur ETag change,
 * et un navigateur ne garde pas une réponse de l'ancienne forme.
 */
const TAGGED_FORMAT = API_FORMAT

/**
 * Une réponse JSON calculée à la demande (`read`), dont l'ETag se tire de ce dont elle dépend
 * (`version` : le jour des prix et ce qui est demandé, par exemple), connu sans la calculer : 304
 * sans rien lire si le navigateur l'a déjà ; 404 si `read` ne rend rien.
 */
export function serveTagged(request: Request, version: string, read: () => unknown) {
  const etag = `"${Bun.hash(`${TAGGED_FORMAT}|${version}`).toString(36)}"`
  const headers = { 'Cache-Control': 'no-cache', ETag: etag }
  if (matchesEtag(request, etag)) return new Response(null, { status: 304, headers })
  const body = read()
  return body === null ? notFound() : Response.json(body, { headers })
}

/**
 * La réponse HTTP d'un instantané ; 404 tant que sa tâche n'est jamais passée. Le corps n'est lu
 * que pour une réponse 200 : en Brotli si le navigateur l'accepte (et que la ligne l'a), sinon en
 * gzip, sinon décompressé. L'ETag et le corps en une seule lecture : la tâche d'ingestion peut
 * écrire entre deux, et un corps neuf partirait avec l'ancien ETag.
 */
export function serveSnapshot(db: Database, name: string, request: Request) {
  const sent = request.headers.get('if-none-match')?.replace(/^W\//, '') ?? ''
  const row = db
    .query(
      `SELECT etag, CASE WHEN etag = ?1 THEN NULL ELSE body END AS body,
              CASE WHEN etag = ?1 THEN NULL ELSE brotli END AS brotli
       FROM snapshots WHERE name = ?2`,
    )
    .get(sent, name) as {
    etag: string
    body: Uint8Array<ArrayBuffer> | null
    brotli: Uint8Array<ArrayBuffer> | null
  } | null
  if (!row) return notFound()
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ETag: row.etag,
    Vary: 'Accept-Encoding',
  }
  if (!row.body) return new Response(null, { status: 304, headers })
  const accepted = request.headers.get('accept-encoding') ?? ''
  if (row.brotli && /\bbr\b/.test(accepted)) {
    return new Response(row.brotli, { headers: { ...headers, 'Content-Encoding': 'br' } })
  }
  return /\bgzip\b/.test(accepted)
    ? new Response(row.body, { headers: { ...headers, 'Content-Encoding': 'gzip' } })
    : new Response(Bun.gunzipSync(row.body), { headers })
}
