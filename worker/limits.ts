/**
 * Les limites de l'entrée d'Internet (`https://api.pokecodex.fr`, `index.ts`), comptées par
 * Cloudflare (`ratelimits` de `wrangler.jsonc`) :
 * - avant le token (une rafale sans token s'arrête là aussi), par réseau (`networkOf`) : 300
 *   demandes par 10 s ;
 * - après lui, par client (le nom de son token, `auth.ts` : un token qui a fui ne gagne rien à
 *   changer d'adresse dans une même région ; Cloudflare tient ses compteurs par lieu), les routes
 *   coûteuses (jusqu'à 1 025 cartes par demande) : 20 par 10 s, et 5 pour les lignes de la liste
 *   de souhaits, les plus lourdes pour la base (comme sur le site).
 * Le chemin lu comme Hono le route (`getPath`, décodé : `/v1/%77ants` est `/v1/wants`). Au-delà :
 * 429 sans corps, avec `Retry-After`, et une ligne au journal par minute au plus. Le site n'y passe
 * pas : il joint le Worker par sa liaison de service.
 */

import { env } from 'cloudflare:workers'
import { getPath } from 'hono/utils/url'
import { journalOnce } from './journal'

/**
 * Le réseau d'une requête : son adresse (celle que Cloudflare écrit, `cf-connecting-ip`), ramenée
 * à son réseau /64 en IPv6 (un fournisseur en donne des milliards à chacun) ; `local` sans adresse
 * (le poste du développeur). Même règle que `visitorOf` du site (`pokedex/worker/journal.ts`) :
 * l'une change, l'autre aussi.
 */
function networkOf(request: Request) {
  const ip = request.headers.get('cf-connecting-ip') || 'local'
  if (!ip.includes(':')) return ip
  const [head = '', tail = ''] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left
  return `${groups.slice(0, 4).join(':')}::/64`
}

/** Les routes coûteuses, et leur limite par client. */
const HEAVY: [route: RegExp, limit: 'HEAVY_LIMIT' | 'WANTS_LIMIT'][] = [
  [/^\/v1\/histories$/, 'HEAVY_LIMIT'],
  [/^\/v1\/wants$/, 'WANTS_LIMIT'],
]

/** La réponse 429, et sa ligne au journal. */
function tooMany(request: Request, path: string) {
  journalOnce('débit', {
    topic: 'accès',
    level: 'warn',
    message: 'Débit dépassé',
    details: { route: `${request.method} ${path}` },
  })
  return new Response(null, {
    status: 429,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '10' },
  })
}

/** Avant le token, par réseau : rien, ou la réponse 429. */
export async function limited(request: Request) {
  if ((await env.ANY_LIMIT.limit({ key: networkOf(request) })).success) return
  return tooMany(request, getPath(request))
}

/** Après le token, les routes coûteuses, par client : rien, ou la réponse 429. */
export async function limitedHeavy(request: Request, client: string) {
  const path = getPath(request)
  const limit = HEAVY.find(([route]) => route.test(path))?.[1]
  if (!limit || (await env[limit].limit({ key: client })).success) return
  return tooMany(request, path)
}
