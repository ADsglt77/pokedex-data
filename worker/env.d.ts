/**
 * Ce que reçoit le Worker (`env` de `cloudflare:workers`) : ses liaisons (`wrangler.jsonc`) et ses
 * secrets (en ligne, ceux du Worker ; en développement, `.env`).
 */
declare namespace Cloudflare {
  interface Env {
    /** Les données de référence (`schema.ts`). */
    DB: D1Database
    /** Les images (`images/…`) et les réponses volumineuses (`snapshots/…`). */
    FILES: R2Bucket
    /** Les limites de l'entrée d'Internet (`limits.ts`). */
    ANY_LIMIT: RateLimit
    HEAVY_LIMIT: RateLimit
    /** Les tâches d'ingestion (`ingest/workflow.ts`). */
    INGEST: Workflow<import('./ingest/workflow').IngestParams>
    /** Les clients de l'entrée d'Internet et leur token (`auth.ts`) : `nom:token,…`. */
    API_TOKENS?: string
  }
}
