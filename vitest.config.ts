/**
 * Les tests du Worker (`bun run test`) : dans le moteur de Cloudflare (workerd), avec la
 * configuration du Worker (`wrangler.jsonc`), une D1 neuve, migrée, une base de l'importateur
 * (`CARDS`) avec ce qu'en lit la tâche `catalog` (`worker/tests/setup.ts`), et deux R2 vides
 * (`FILES`, `IMPORTS`). Leurs propres clients, jamais ceux de `.env`.
 */

import { fileURLToPath, URL } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Le second token contient « : » (`worker/tests/api.test.ts`).
          API_TOKENS:
            'pokedex:token-d-essai-de-32-caracteres-au-moins,moi:autre-token-de-32-caracteres-au-moins:suite',
          MIGRATIONS: await readD1Migrations('worker/migrations'),
        },
        // Le même bucket en ligne, mais deux R2 ici : avec un seul (Miniflare les range par
        // `bucket_name`), une image des tâches (`FILES`) passerait pour une de l'importateur.
        r2Buckets: { FILES: 'FILES', IMPORTS: 'IMPORTS' },
      },
    }),
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['worker/tests/**/*.test.ts'], setupFiles: ['./worker/tests/setup.ts'] },
}))
