/**
 * Tâche `sprites`, à la demande (à l'installation : `bun run ingest setup` ; et quand une génération
 * s'ajoute) : copie d'avance dans R2 (`FILES`, `images/species/…`) le sprite et le PNG de
 * l'illustration officielle des 1 025 Pokémon, d'après PokéAPI : l'API n'en télécharge jamais
 * elle-même (`worker/images.ts`). Le site montre l'illustration en WebP sans perte, que le Worker ne
 * sait pas produire : convertie depuis ce PNG, hors du Worker, par un script ponctuel
 * (`docs/donnees.md`) ; d'ici là, l'API sert le PNG à sa place. Leurs chemins sont neutres
 * (`lib/image-paths.ts`) : seule la table `UPSTREAMS`, ici, connaît leur adresse d'origine.
 * Seules les images qui manquent sont téléchargées, deux à la fois, par étapes de 100 Pokémon (une
 * étape en échec est reprise seule). Une image en erreur (panne, réponse qui n'est pas un PNG)
 * n'empêche pas les autres : la tâche échoue à la fin, pour être relancée ; à la 20e erreur, la
 * source est sans doute en panne : elle s'arrête là.
 */

import { env } from 'cloudflare:workers'
import { SPECIES_IDS } from '@/config/pokedex'
import { artworkSource, spriteUrl } from '@/lib/image-paths'
import { plural, reasonOf, taskJournal } from '../journal'
import { mapPool, politeFetch, readCapped } from './net'
import type { Step } from './workflow'

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'

/** L'adresse d'origine du sprite et du PNG de l'illustration d'un Pokémon. */
const UPSTREAMS = {
  sprite: (id: number) => `${SPRITES}/${id}.png`,
  artwork: (id: number) => `${SPRITES}/other/official-artwork/${id}.png`,
}

/**
 * Copie dans R2 l'image d'un chemin (`/images/species/…`) depuis `url`, si elle n'y est pas déjà :
 * `true` si elle y est (déjà, ou maintenant), `false` si la source ne l'a pas (404). Une autre
 * erreur (panne, redirection, réponse qui n'est pas un PNG, ou de plus de 5 Mo : `readCapped`) est
 * levée : réessayer plus tard.
 */
export async function mirror(path: string, url: string) {
  const key = path.slice(1)
  if (await env.FILES.head(key)) return true
  const response = await politeFetch(url)
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.split(';')[0]!.trim() !== 'image/png') {
    throw new Error(`Pas une image PNG (${contentType}) : ${url}`)
  }
  await env.FILES.put(key, await readCapped(response, url), {
    httpMetadata: { contentType: 'image/png' },
  })
  return true
}

/** À la 20e erreur, la source est sans doute en panne : on ne la sollicite pas davantage. */
const MAX_FAILURES = 20

/** Les Pokémon copiés par étape. */
const PER_STEP = 100

/**
 * Le sprite et le PNG de l'illustration de ces Pokémon, deux à la fois : une image en erreur est
 * dite au journal et passée. Rend les images trouvées, et les chemins en erreur.
 */
async function copySpecies(ids: readonly number[]) {
  const failed: string[] = []
  const copy = async (path: string, url: string) => {
    try {
      return await mirror(path, url)
    } catch (error) {
      failed.push(path)
      taskJournal('warn', 'Image en erreur', { chemin: path, raison: reasonOf(error) })
      return false
    }
  }
  const copied = await mapPool(ids, 2, async (id) => [
    await copy(spriteUrl(id), UPSTREAMS.sprite(id)),
    await copy(artworkSource(id), UPSTREAMS.artwork(id)),
  ])
  return { found: copied.flat().filter(Boolean).length, failed }
}

export async function sprites(step: Step) {
  const failed: string[] = []
  let found = 0
  for (let from = 0; from < SPECIES_IDS.length; from += PER_STEP) {
    const ids = SPECIES_IDS.slice(from, from + PER_STEP)
    const done = await step(`Pokémon ${ids[0]} à ${ids.at(-1)}`, () => copySpecies(ids))
    found += done.found
    failed.push(...done.failed)
    if (failed.length >= MAX_FAILURES) {
      throw new Error(`${failed.length} images en erreur : la source est sans doute en panne`)
    }
  }
  // Le bilan dans sa propre étape, comme toute ligne du journal (`Step`).
  await step('bilan', async () => taskJournal('ok', 'Images des Pokémon', { trouvées: found }))
  if (failed.length) {
    const some = failed.slice(0, 5).join(', ')
    const count = plural(failed.length, 'image en erreur', 'images en erreur')
    throw new Error(`${count}, redemandées au prochain passage (${some})`)
  }
}
