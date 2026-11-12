/**
 * Le Workflow d'un passage (`worker/ingest/workflow.ts`, `Ingest`) : chaque tâche a son passage
 * (`runs`), noté réussi, ou en échec avec sa raison, même quand une tâche d'avant a échoué ; chaque
 * étape donne signe de vie en commençant, puis quand la tâche le redit, une minute au moins après
 * le précédent (sans lui, un passage serait tenu pour arrêté, et une autre tâche lancée en même
 * temps doublerait le rythme convenu avec la source) ; une tâche déjà en cours est passée, pas les
 * suivantes. Les tâches remplacées (ni réseau, ni source) ; les étapes du Workflow jouées une fois,
 * telles quelles.
 */

import { env, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { beforeEach, expect, test, vi } from 'vitest'
import type { IngestJob } from '@/config/jobs'
import { MINUTE } from '@/lib/time'
import type { Alive, IngestParams, Step } from '../ingest/workflow'
import { rows } from './helpers'

// Les tâches `prices` et `species` remplacées, et le signe de vie (`beat`) compté ; `workflow.ts`,
// déjà chargé par l'entrée du Worker, rechargé pour les prendre.
const tasks = vi.hoisted(() => ({
  prices: vi.fn<(alive: Alive) => Promise<void>>(),
  species: vi.fn<(step: Step) => Promise<void>>(),
  beat: vi.fn<(id: number) => Promise<void>>(),
}))
vi.mock(import('../ingest/prices'), async (original) => ({
  ...(await original()),
  prices: tasks.prices,
}))
vi.mock(import('../ingest/species'), async (original) => ({
  ...(await original()),
  species: tasks.species,
}))
vi.mock(import('../ingest/runs'), async (original) => {
  const runs = await original()
  return { ...runs, beat: tasks.beat.mockImplementation(runs.beat) }
})
vi.resetModules()
const { Ingest } = await import('../ingest/workflow')

/** Les étapes du Workflow, jouées aussitôt, une fois ; leur nom noté. */
const names: string[] = []
const step = {
  do: async (name: string, ...rest: unknown[]) => {
    names.push(name)
    return (rest.at(-1) as () => Promise<unknown>)()
  },
} as unknown as WorkflowStep

/**
 * Un passage de ces tâches, dans l'ordre, sans le moteur des Workflows (possible avec
 * `introspectWorkflow`, pas employé ici : ni les nouveaux essais d'une étape, ni leur rejeu ne
 * sont testés) : `run` n'emploie pas `this`, ses tâches lisent `env` de `cloudflare:workers`.
 */
const ingest = (jobs: IngestJob[]) =>
  Ingest.prototype.run.call(
    null,
    {
      payload: { jobs },
      timestamp: new Date(),
      instanceId: 'essai',
    } as WorkflowEvent<IngestParams>,
    step,
  )

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM runs').run()
  tasks.prices.mockReset()
  tasks.species.mockReset()
  tasks.beat.mockClear()
  names.length = 0
})

test('une tâche en échec, puis une qui réussit : chacune son passage, l’échec avec sa raison ; le signe de vie à chaque étape, et une minute après le précédent', async () => {
  // Les signes de vie notés après chaque appel d'`alive` : rien de plus aussitôt, un de plus après.
  const beats: number[] = []
  tasks.prices.mockImplementation(async (alive) => {
    // Aussitôt redit : rien (moins d'une minute après celui de l'étape).
    await alive()
    beats.push(tasks.beat.mock.calls.length)
    // Deux minutes plus tard : redit ; aussitôt après, rien de plus (une minute à partir de lui).
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * MINUTE)
    try {
      await alive()
      beats.push(tasks.beat.mock.calls.length)
      await alive()
      beats.push(tasks.beat.mock.calls.length)
    } finally {
      clock.mockRestore()
    }
    throw new Error('Guide des prix illisible')
  })
  tasks.species.mockImplementation(async (jobStep) => {
    await jobStep('espèces 1 à 100', async () => null)
  })
  await ingest(['prices', 'species'])
  expect(await rows('SELECT job, ok, message FROM runs ORDER BY id')).toEqual([
    { job: 'prices', ok: 0, message: 'Guide des prix illisible' },
    { job: 'species', ok: 1, message: null },
  ])
  const [pricesRun, speciesRun] = (await rows('SELECT id FROM runs ORDER BY id')).map(
    ({ id }) => id,
  )
  // `prices` : au début de son étape, puis deux minutes après ; `species` : au début de la sienne.
  expect(beats).toEqual([1, 2, 2])
  expect(tasks.beat.mock.calls).toEqual([[pricesRun], [pricesRun], [speciesRun]])
  expect(names).toEqual([
    '1. prices : début',
    '1. prices : guide des prix',
    '1. prices : échec',
    '2. species : début',
    '2. species : espèces 1 à 100',
    '2. species : fin',
  ])
})

test('une tâche déjà en cours (un passage en vie) est passée, pas celles qui la suivent', async () => {
  const now = new Date().toISOString()
  await env.DB.prepare('INSERT INTO runs (job, started_at, alive_at) VALUES (?, ?, ?)')
    .bind('prices', now, now)
    .run()
  tasks.species.mockResolvedValue()
  await ingest(['prices', 'species'])
  expect(tasks.prices).not.toHaveBeenCalled()
  expect(tasks.species).toHaveBeenCalledOnce()
  expect(await rows('SELECT job, ok FROM runs ORDER BY id')).toEqual([
    { job: 'prices', ok: null },
    { job: 'species', ok: 1 },
  ])
})
