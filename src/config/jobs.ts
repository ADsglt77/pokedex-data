/**
 * Les tâches d'ingestion (`worker/ingest/`), dans l'ordre où les montre l'état (`/v1/status`) :
 * leur nom affiché et leur rythme (le Cron les relance quand il est écoulé). `sprites` ne passe
 * jamais seule : on la lance à l'installation, ou quand une génération s'ajoute
 * (`bun run ingest sprites`).
 */

import { DAY, HOUR, MINUTE } from '@/lib/time'

export type IngestJob = 'species' | 'catalog' | 'sprites' | 'prices'

export const INGEST_JOBS: Record<
  IngestJob,
  {
    label: string
    /**
     * Elle repart quand le début de sa dernière réussite a plus que cet intervalle (ms, à 10 min
     * près : `isDue`) ; `null` : à la demande.
     */
    every: number | null
  }
> = {
  // Les espèces ne changent qu'avec une nouvelle génération.
  species: { label: 'Espèces', every: 30 * DAY },
  // Le catalogue que l'importateur tient à jour (TCGdex, chaque semaine ; les détails des cartes en
  // continu) : relu chaque jour, sans requête vers TCGdex.
  catalog: { label: 'Catalogue', every: DAY },
  // Les sprites et les illustrations des 1 025 Pokémon : seulement ceux qui manquent.
  sprites: { label: 'Images des Pokémon', every: null },
  // Le guide change une fois par jour ; la tâche ne retélécharge que ce qui a changé.
  prices: { label: 'Prix', every: 6 * HOUR },
}

/** Leurs noms, dans l'ordre d'`INGEST_JOBS`. */
export const INGEST_JOB_NAMES = Object.keys(INGEST_JOBS) as IngestJob[]

/**
 * Un passage en cours donne signe de vie à chacune de ses étapes, et chaque minute des plus longues
 * (`worker/ingest/runs.ts`) ; sans signe de vie depuis 5 min, il est tenu pour arrêté net. Le plus
 * ancien signe de vie d'un passage encore en cours, à `now` (ms).
 */
export const aliveSince = (now: number) => new Date(now - 5 * MINUTE).toISOString()
