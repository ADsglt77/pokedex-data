/**
 * L'API, sous `/v1` : l'état des tâches (`status.ts`), les données de référence (`reference.ts`)
 * et les images copiées (`images.ts`). Les deux entrées du Worker la servent (`index.ts`). Une
 * adresse inconnue : 404 sans corps ; une erreur imprévue : dans le journal, et 500 sans corps
 * (rien de ses détails ne part au client).
 */

import { Hono } from 'hono'
import { serveImage } from './images'
import { journal } from './journal'
import { referenceRoutes } from './reference'
import { notFound } from './snapshots'
import { statusRoutes } from './status'

export const app = new Hono()
  .basePath('/v1')
  .route('/', statusRoutes)
  .route('/', referenceRoutes)
  .get('/images/*', serveImage)
  .notFound(notFound)
  .onError((error, c) => {
    journal({
      topic: 'serveur',
      level: 'error',
      message: 'Erreur de l’API',
      details: { route: `${c.req.method} ${c.req.path}` },
    })
    console.error(error)
    return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  })
