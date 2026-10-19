/**
 * Réseau des tâches d'ingestion : un `fetch` JSON avec un cache disque (`DATA_DIR/cache/pokeapi` :
 * pour relancer une tâche sans solliciter PokéAPI à nouveau) et une file à concurrence limitée.
 * Chaque requête s'identifie, attend 100 ms avant de partir et échoue au bout de 2 min sans réponse
 * complète. Un 404 arrête la tâche. Une réponse en cache sert tant qu'elle a moins d'un mois ;
 * `--refresh` redemande tout.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DAY } from '@/lib/time'
import { DATA_DIR } from '../db'

/** Les documents JSON lus (ceux de PokéAPI, la seule API lue ainsi), gardés un mois. */
const CACHE_DIR = join(DATA_DIR, 'cache', 'pokeapi')
const MAX_AGE = 30 * DAY

/** `--refresh` : ignore le cache et redemande tout. */
export const refresh = process.argv.includes('--refresh')

class NotFoundError extends Error {}

const USER_AGENT = 'pokedex-perso/1.0 (Pokédex personnel)'

/**
 * Au-delà, une requête échoue, lecture de la réponse comprise : une connexion qui ne répond plus ne
 * bloque pas les tâches, qui passent l'une après l'autre (le guide des prix, 29 Mo, arrive en
 * quelques secondes).
 */
const TIMEOUT = 120_000

/** Une requête identifiée, après 100 ms d'attente, et 2 min au plus. */
export async function politeFetch(url: string, init?: RequestInit) {
  await Bun.sleep(100)
  return fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...init?.headers },
  })
}

/**
 * Une requête identifiée, sans attente, 15 s au plus : une image qu'une page attend (copiée à la
 * demande, `images.ts`).
 */
export const quickFetch = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': USER_AGENT } })

/** Une requête identifiée qui a réussi ; sinon (404 compris), une erreur. */
export async function download(url: string, init?: RequestInit) {
  const response = await politeFetch(url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`)
  return response
}

/** Document JSON, lu dans le cache s'il y a été mis il y a moins d'un mois. */
export async function fetchJson<T>(url: string): Promise<T> {
  // La clé des fichiers déjà en cache : celle d'une requête GET sans corps.
  const key = createHash('sha1').update(`GET ${url}\n`).digest('hex')
  const file = join(CACHE_DIR, `${key}.json`)

  if (!refresh) {
    try {
      if (Date.now() - (await stat(file)).mtimeMs < MAX_AGE) {
        return JSON.parse(await readFile(file, 'utf8')) as T
      }
    } catch {
      // Pas encore en cache.
    }
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await politeFetch(url)
      // Un 404 est une réponse : réessayer n'y changerait rien.
      if (response.status === 404) throw new NotFoundError(`404 pour ${url}`)
      if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`)
      const text = await response.text()
      const data = JSON.parse(text) as T
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text, 'utf8')
      return data
    } catch (error) {
      if (error instanceof NotFoundError || attempt === 4) throw error
      await Bun.sleep(500 * 2 ** attempt)
    }
  }
}

/**
 * `task` sur chaque élément, au plus `concurrency` à la fois ; les résultats gardent l'ordre. Une
 * erreur arrête la distribution et n'est levée qu'une fois finies les tâches en cours : aucune ne
 * continue après la fin de la tâche, en même temps que la suivante.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  let stopped = false
  const worker = async () => {
    while (next < items.length && !stopped) {
      const index = next++
      try {
        results[index] = await task(items[index]!)
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker)
  for (const outcome of await Promise.allSettled(workers)) {
    if (outcome.status === 'rejected') throw outcome.reason
  }
  return results
}
