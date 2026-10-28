/**
 * L'API (Elysia), sous `/v1` : l'état des tâches (`status.ts`), les données de référence
 * (`reference.ts`) et les images copiées (`images.ts`). Chaque requête porte un token (`auth.ts`),
 * sauf `/v1/health` ; sur l'entrée d'Internet, les limites par adresse passent avant
 * (`limits.ts`). Les paramètres sont validés par leurs schémas (422 sinon). Une adresse inconnue :
 * 404 sans corps ; une erreur imprévue : dans le journal, et 500 sans corps. La description de l'API
 * (OpenAPI) : `/docs/json`, avec le token, à importer dans un client HTTP ; en développement, aussi
 * sa page, `/docs` (sans token : elle ne rend aucune donnée).
 */

import { openapi } from '@elysiajs/openapi'
import type { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import { guard, type Clients } from './auth'
import { serveImage } from './images'
import { journal } from './journal'
import { referenceRoutes } from './reference'
import { notFound } from './snapshots'
import { statusRoutes } from './status'

const DEV = process.env.NODE_ENV !== 'production'

/** `limit` : les limites de l'entrée d'Internet (`publicLimits`), rien ou la réponse 429. */
export function createApp(
  data: Database,
  clients: Clients,
  limit?: (request: Request) => Response | undefined,
) {
  return (
    new Elysia()
      .use(
        openapi({
          // En production, la description seule (`/docs/json`), sans la page qui charge son script
          // d'un CDN.
          provider: DEV ? 'scalar' : null,
          path: '/docs',
          documentation: {
            info: {
              title: 'Pokédex · données',
              version: '1',
              description:
                'L’API privée des données du Pokédex de cartes japonaises et françaises.',
            },
            components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } },
            security: [{ token: [] }],
          },
        }),
      )
      .onRequest(({ request }) => {
        if (DEV && new URL(request.url).pathname.startsWith('/docs')) return
        return limit?.(request) ?? guard(clients, request)
      })
      // Une adresse inconnue : 404, sans corps. Laissés à Elysia : un paramètre refusé par son
      // schéma (422) et un statut levé exprès (un code numérique). Tout le reste est inattendu,
      // même une erreur qui porte son propre code (base verrouillée `SQLITE_BUSY`, fichier absent
      // `ENOENT`…) : dans le journal, et 500 sans corps (rien de ses détails ne part au client).
      .onError(({ code, error, request }) => {
        if (code === 'NOT_FOUND') return notFound()
        if (code === 'VALIDATION' || code === 'PARSE' || typeof code === 'number') return
        const { pathname } = new URL(request.url)
        journal({
          topic: 'serveur',
          level: 'error',
          message: 'Erreur de l’API',
          details: { route: `${request.method} ${pathname}` },
        })
        console.error(error)
        return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } })
      })
      .group('/v1', (api) =>
        api
          .use(statusRoutes(data))
          .use(referenceRoutes(data))
          .get('/images/*', ({ request }) => serveImage(data, request), {
            detail: { summary: 'Une image copiée', tags: ['Images'] },
          }),
      )
  )
}
