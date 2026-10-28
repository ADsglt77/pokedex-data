/**
 * Les tâches d'ingestion (`worker/ingest/`), dans l'ordre où les montre l'état (`/v1/status`) :
 * leur nom affiché et leur rythme (le Cron les relance quand il est écoulé). Celles à la demande ne
 * passent jamais seules : on les lance quand de nouvelles cartes sortent (`bun run ingest cards`,
 * qui enchaîne les trois).
 */

import { DAY, HOUR, MINUTE } from '@/lib/time'

export type IngestJob = 'species' | 'catalog' | 'images' | 'prices' | 'history'

export const INGEST_JOBS: Record<
  IngestJob,
  {
    label: string
    /** Elle repart quand sa dernière réussite a plus que cet intervalle (ms) ; `null` : à la demande. */
    every: number | null
  }
> = {
  // Les espèces ne changent qu'avec une nouvelle génération.
  species: { label: 'Espèces', every: 30 * DAY },
  // De nouvelles cartes quelques fois par mois (une page par série, toutes les 3 s).
  catalog: { label: 'Catalogue', every: null },
  // Les images des nouvelles cartes, toutes copiées d'avance : l'API n'en copie jamais une elle-même.
  images: { label: 'Images copiées', every: null },
  // Le guide change une fois par jour ; la tâche ne retélécharge que ce qui a changé.
  prices: { label: 'Prix', every: 6 * HOUR },
  // Les 180 derniers jours de chaque carte, lus une fois par carte (la première fois, environ 23 h
  // pour les japonaises, 21 h de plus pour les françaises).
  history: { label: 'Historique des prix', every: null },
}

/** Leurs noms, dans l'ordre d'`INGEST_JOBS`. */
export const INGEST_JOB_NAMES = Object.keys(INGEST_JOBS) as IngestJob[]

/**
 * Un passage en cours donne signe de vie à chacune de ses étapes (`worker/ingest/runs.ts`) ; sans
 * signe de vie depuis 5 min, il est tenu pour arrêté net. Le plus ancien signe de vie d'un passage
 * encore en cours, à `now` (ms).
 */
export const aliveSince = (now: number) => new Date(now - 5 * MINUTE).toISOString()
