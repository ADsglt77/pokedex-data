/**
 * Les tests du Worker (`bun run test`) : dans le moteur de Cloudflare (workerd), avec la
 * configuration du Worker (`wrangler.jsonc`), une D1 neuve, migrée (`worker/tests/setup.ts`), et un
 * R2 vide. Leurs propres clients, jamais ceux de `.env`.
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
      },
    }),
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['worker/tests/**/*.test.ts'], setupFiles: ['./worker/tests/setup.ts'] },
}))
