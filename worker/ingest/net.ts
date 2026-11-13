/**
 * Le réseau des tâches d'ingestion : chaque requête s'identifie, attend 100 ms avant de partir et
 * échoue au bout de 2 min sans réponse complète ; une redirection n'est jamais suivie (une réponse
 * 3xx est une erreur : la source ne mène que là où on l'a demandée) ; une réponse lue d'un coup
 * l'est jusqu'à 5 Mo (`readCapped`) ; un document JSON (PokéAPI) réessayé en cas de panne ; une
 * file à concurrence limitée (`mapPool`). Un 404 ou une réponse trop grosse ne sont pas réessayés
 * (`fetchJson`) : ce sont des réponses.
 */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class NotFoundError extends Error {}

class TooLargeError extends Error {}

const USER_AGENT = 'pokedex-perso/1.0 (Pokedex personnel)'

/**
 * Au-delà, une requête échoue, lecture de la réponse comprise : une connexion qui ne répond plus ne
 * bloque pas les tâches (le guide des prix, 16 Mo, arrive en quelques secondes).
 */
const TIMEOUT = 120_000

/** Une requête identifiée, après 100 ms d'attente, 2 min au plus, sans suivre de redirection. */
export async function politeFetch(url: string, init?: RequestInit) {
  await sleep(100)
  return fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    ...init,
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, ...init?.headers },
  })
}

/**
 * Au-delà, une réponse lue d'un coup n'est pas celle attendue (une page ou un script de
 * Pokécardex, une image, un document de PokéAPI : quelques centaines de Ko) : une erreur, plutôt
 * que la mémoire du Worker épuisée, ou une « image » de dizaines de Mo gardée dans R2 et servie.
 * Le guide des prix et la liste des produits, plus gros, sont lus en flux (`json-stream.ts`).
 */
const MAX_READ = 5_000_000

/** Le corps d'une réponse, 5 Mo au plus (`MAX_READ`), sa taille annoncée ou non. */
export async function readCapped(response: Response, url: string) {
  const tooLarge = () => new TooLargeError(`Plus de 5 Mo pour ${url}`)
  if (Number(response.headers.get('content-length')) > MAX_READ) {
    await response.body?.cancel()
    throw tooLarge()
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  for (let next = await reader?.read(); next && !next.done; next = await reader!.read()) {
    size += next.value.byteLength
    if (size > MAX_READ) {
      await reader!.cancel()
      throw tooLarge()
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

/** Le texte d'une réponse, 5 Mo au plus (`readCapped`). */
export const readText = async (response: Response, url: string) =>
  new TextDecoder().decode(await readCapped(response, url))

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
      return JSON.parse(await readText(response, url)) as T
    } catch (error) {
      // Un 404 ou une réponse trop grosse : réessayer n'y changerait rien.
      if (error instanceof NotFoundError || error instanceof TooLargeError || attempt === 4) {
        throw error
      }
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
