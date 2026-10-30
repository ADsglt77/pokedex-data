/**
 * Le réseau des tâches d'ingestion : chaque requête s'identifie, attend 100 ms avant de partir et
 * échoue au bout de 2 min sans réponse complète ; un document JSON (PokéAPI) réessayé en cas de
 * panne ; une file à concurrence limitée (`mapPool`). Un 404 n'est pas réessayé (`fetchJson`) :
 * c'est une réponse.
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class NotFoundError extends Error {}

const USER_AGENT = 'pokedex-perso/1.0 (Pokedex personnel)'

/**
 * Au-delà, une requête échoue, lecture de la réponse comprise : une connexion qui ne répond plus ne
 * bloque pas les tâches (le guide des prix, 16 Mo, arrive en quelques secondes).
 */
const TIMEOUT = 120_000

/** Une requête identifiée, après 100 ms d'attente, et 2 min au plus. */
export async function politeFetch(url: string, init?: RequestInit) {
  await sleep(100)
  return fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...init?.headers },
  })
}

/** Une requête identifiée qui a réussi ; sinon (404 compris), une erreur. */
export async function download(url: string, init?: RequestInit) {
  const response = await politeFetch(url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`)
  return response
}

/** Un document JSON ; une panne est réessayée quatre fois, de plus en plus tard. */
export async function fetchJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await politeFetch(url)
      // Un 404 est une réponse : réessayer n'y changerait rien.
      if (response.status === 404) throw new NotFoundError(`404 pour ${url}`)
      if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`)
      return await response.json<T>()
    } catch (error) {
      if (error instanceof NotFoundError || attempt === 4) throw error
      await sleep(500 * 2 ** attempt)
    }
  }
}

/**
 * `task` sur chaque élément, au plus `concurrency` à la fois ; les résultats gardent l'ordre. Une
 * erreur arrête la distribution et n'est levée qu'une fois finies les tâches en cours : aucune ne
 * continue après la fin de l'étape.
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
