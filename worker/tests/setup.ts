/**
 * Avant chaque fichier de test du Worker (`vitest.config.ts`) : sa D1, migrée comme celle du
 * Worker (`worker/migrations`, lues par la configuration : `MIGRATIONS`, `env.d.ts`), et la base de
 * l'importateur (`CARDS`), avec ce qu'en lit la tâche `catalog` (`cards-schema.ts`).
 */

import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { CARDS_SCHEMA } from './cards-schema'

await applyD1Migrations(env.DB, env.MIGRATIONS)
await env.CARDS.batch(CARDS_SCHEMA.map((sql) => env.CARDS.prepare(sql)))
