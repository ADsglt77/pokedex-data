/**
 * Drizzle Kit (`bun run db:generate`) : compare le schéma du Worker (`worker/schema.ts`) aux
 * migrations déjà écrites et écrit la suivante dans `worker/migrations`, où Wrangler les lit.
 */

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './worker/schema.ts',
  out: './worker/migrations',
})
