/**
 * Les réponses volumineuses de l'API (catalogue, espèces) : calculées une fois en fin de tâche
 * d'ingestion et gardées compressées (gzip), avec leur ETag. L'API sert la ligne telle quelle :
 * celui qui a déjà la version du jour reçoit un 304, sans corps (lu sans elle). Aussi, pour toute
 * l'API : le 404 sans corps (`notFound`) et une réponse calculée à la demande dont l'ETag se
 * connaît d'avance (`serveTagged`).
 */

import type { Database } from 'bun:sqlite'

/**
 * La forme des réponses de l'API (`contract.ts`, dont le site garde une copie dans son
 * `src/types.ts`), dans l'ETag des réponses calculées à la demande : à augmenter avec elle, un
 * client ne garde jamais une réponse d'une ancienne forme. 2 : les prix rendent une clé par carte
 * demandée, `null` sans prix (octobre 2026). 3 : le prix d'une carte suit la règle de Pokécardex,
 * et son troisième nombre est son prix d'il y a 30 jours (octobre 2026).
 */
const FORMAT = 3

/**
 * Enregistre la réponse, avec son ETag, qui ne change qu'avec son contenu : inchangée (même ETag),
 * rien n'est recompressé.
 */
export function saveSnapshot(db: Database, name: string, data: unknown) {
  const text = JSON.stringify(data)
  const etag = `"${Bun.hash(text).toString(36)}"`
  if (db.query('SELECT 1 FROM snapshots WHERE name = ? AND etag = ?').get(name, etag)) return
  db.query(
    `INSERT INTO snapshots (name, etag, body) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET etag = excluded.etag, body = excluded.body`,
  ).run(name, etag, Bun.gzipSync(text, { level: 9 }))
}

/** 404, sans corps ni cache : ce qui manque peut arriver (une tâche, une image copiée). */
export const notFound = () =>
  new Response(null, { status: 404, headers: { 'Cache-Control': 'no-cache' } })

/**
 * L'ETag que le client a déjà (`If-None-Match`) ; le nginx du site (entre Caddy et l'API)
 * l'affaiblit en `W/"…"` quand il compresse la réponse : c'est le même.
 */
const sentEtag = (request: Request) => request.headers.get('if-none-match')?.replace(/^W\//, '')

/**
 * Une réponse JSON calculée à la demande (`read`), dont l'ETag se tire de ce dont elle dépend
 * (`version` : le jour des prix et ce qui est demandé, par exemple), connu sans la calculer : 304
 * sans rien lire si le client l'a déjà ; 404 si `read` ne rend rien.
 */
export function serveTagged(request: Request, version: string, read: () => unknown) {
  const etag = `"${Bun.hash(`${FORMAT}|${version}`).toString(36)}"`
  const headers = { 'Cache-Control': 'no-cache', ETag: etag }
  if (sentEtag(request) === etag) return new Response(null, { status: 304, headers })
  const body = read()
  return body === null ? notFound() : Response.json(body, { headers })
}

/**
 * La réponse HTTP d'un instantané ; 404 tant que sa tâche n'est jamais passée. L'ETag et le corps
 * en une seule lecture (la tâche d'ingestion peut écrire entre deux, et un corps neuf partirait
 * avec l'ancien ETag) ; le corps en gzip si le client l'accepte, sinon décompressé.
 */
export function serveSnapshot(db: Database, name: string, request: Request) {
  const row = db.query('SELECT etag, body FROM snapshots WHERE name = ?').get(name) as {
    etag: string
    body: Uint8Array<ArrayBuffer>
  } | null
  if (!row) return notFound()
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ETag: row.etag,
    Vary: 'Accept-Encoding',
  }
  if (sentEtag(request) === row.etag) return new Response(null, { status: 304, headers })
  return /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')
    ? new Response(row.body, { headers: { ...headers, 'Content-Encoding': 'gzip' } })
    : new Response(Bun.gunzipSync(row.body), { headers })
}
