/**
 * Les limites de l'entrée d'Internet (`https://api.pokecodex.fr`, `index.ts`), vérifiées avant le
 * token (une rafale sans token s'arrête là aussi), par adresse (celle que Cloudflare écrit,
 * `cf-connecting-ip`) : 300 demandes par 10 s, et 20 pour les routes coûteuses (jusqu'à 1 025
 * cartes par demande). Comptées par Cloudflare (`ratelimits` de `wrangler.jsonc`). Au-delà : 429
 * sans corps, avec `Retry-After`, et une ligne au journal par minute au plus. Le site n'y passe
 * pas : il joint le Worker par sa liaison de service.
 */

import { env } from 'cloudflare:workers'
import { MINUTE } from '@/lib/time'
import { journalOnce } from './journal'

/** Les routes coûteuses : jusqu'à 1 025 cartes par demande, lues en base. */
const HEAVY = /^\/v1\/(histories|wants)$/

/** Rien, ou la réponse 429. */
export async function limited(request: Request) {
  const key = request.headers.get('cf-connecting-ip') ?? 'local'
  const { pathname } = new URL(request.url)
  const allowed =
    (await env.ANY_LIMIT.limit({ key })).success &&
    (!HEAVY.test(pathname) || (await env.HEAVY_LIMIT.limit({ key })).success)
  if (allowed) return
  journalOnce(
    'débit',
    {
      topic: 'accès',
      level: 'warn',
      message: 'Débit dépassé',
      details: { route: `${request.method} ${pathname}` },
    },
    MINUTE,
  )
  return new Response(null, {
    status: 429,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '10' },
  })
}
