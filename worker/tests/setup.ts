/**
 * Avant chaque fichier de test du Worker (`vitest.config.ts`) : sa D1, migrée comme celle du
 * Worker (`worker/migrations`, lues par la configuration : `MIGRATIONS`, `env.d.ts`).
 */

import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

await applyD1Migrations(env.DB, env.MIGRATIONS)
