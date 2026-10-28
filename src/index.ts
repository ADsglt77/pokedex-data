/**
 * Lance l'API (`app.ts`) : sur le réseau Docker du VPS pour le site (`http://data-api:3001`), et, si
 * `PUBLIC_PORT`, sur un second port pour Internet (`https://api.pokecodex.fr` : Caddy, sur le VPS,
 * le relaie vers ce port publié en local seulement, `compose.yaml`), la même API avec des limites
 * par adresse (`limits.ts`) ; sur cette machine en développement (`bun run dev`). Elle lit
 * `data.db` et les images, que remplissent les tâches d'ingestion (`ingest.ts`) ; elle n'écrit que,
 * à son démarrage, les étapes du schéma qui manquent. Au démarrage, elle le dit dans son journal
 * (`banner`).
 */

import { createApp } from './app'
import { readClients } from './auth'
import { openData } from './db'
import { banner } from './journal'
import { publicLimits } from './limits'

const clients = readClients(process.env.API_TOKENS ?? '', process.env.NODE_ENV === 'production')
const data = openData({ readonly: true })
// Sur cette machine seulement, sauf `HOST` (`0.0.0.0` dans son conteneur, que joint le site) : en
// développement, sur un Wi-Fi public, l'API ne s'ouvre pas aux autres appareils.
const hostname = process.env.HOST ?? '127.0.0.1'
const server = createApp(data, clients).listen({ port: Number(process.env.PORT ?? 3001), hostname })
const entry = process.env.PUBLIC_PORT
  ? createApp(data, clients, publicLimits()).listen({
      port: Number(process.env.PUBLIC_PORT),
      hostname,
    })
  : null

banner({
  api: String(server.server?.url),
  entry: entry && String(entry.server?.url),
  clients: clients.map(({ name }) => name),
})
