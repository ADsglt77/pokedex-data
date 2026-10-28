/**
 * L'entrée de l'API sur Internet, `https://api.pokecodex.fr` : Caddy la relaie vers un second port
 * (`PUBLIC_PORT`, `index.ts`), publié sur le VPS seulement (`compose.yaml`). Le token y est exigé
 * comme partout (`auth.ts`) ; s'y ajoutent des limites par adresse, vérifiées avant lui (une rafale
 * sans token s'arrête là aussi) : au-delà, 429 sans corps, avec `Retry-After`, et une ligne au
 * journal par minute au plus. Le site joint l'API par le réseau Docker, sur son port à elle, sans
 * ces limites : son nginx limite déjà chaque visiteur.
 *
 * L'adresse : celle que Caddy écrit dans `x-forwarded-for` (il remplace celle reçue du public, il ne
 * se fie à aucun relais : `deploy/Caddyfile` du site) ; sans elle (une demande faite sur le VPS
 * même), une seule clé, `local`.
 */

import { MINUTE } from '@/lib/time'
import { journalOnce } from './journal'

/** Les routes coûteuses : jusqu'à 1 025 cartes par demande, chacune lue en base. */
const HEAVY = /^\/v1\/(histories|wants)$/

/**
 * Un seau par clé, comme `limit_req … nodelay` de nginx : `rate` demandes par seconde, `burst` d'un
 * coup. Rend 0 si la demande passe, sinon les secondes à attendre. `now` : en ms.
 */
function bucket(rate: number, burst: number) {
  const buckets = new Map<string, { tokens: number; at: number }>()
  const fill = ({ tokens, at }: { tokens: number; at: number }, now: number) =>
    Math.min(burst, tokens + ((now - at) / 1000) * rate)
  let swept = 0
  return (key: string, now: number) => {
    // Une fois par minute, les seaux redevenus pleins sont oubliés : la mémoire ne garde que les
    // adresses actives.
    if (now - swept > MINUTE) {
      for (const [known, seen] of buckets) if (fill(seen, now) === burst) buckets.delete(known)
      swept = now
    }
    const seen = buckets.get(key)
    const tokens = seen ? fill(seen, now) : burst
    const left = tokens >= 1 ? tokens - 1 : tokens
    buckets.set(key, { tokens: left, at: now })
    return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / rate)
  }
}

/**
 * Les limites de l'entrée sur Internet, par adresse : toute demande, 20 par seconde et 300 d'un coup
 * (un script qui copie les images d'une série) ; les routes coûteuses, en plus, 2 par seconde et 10
 * d'un coup, comme sur le site (`deploy/nginx.conf.template`). Rien, ou la réponse 429. `clock` : en
 * ms, fixée par les tests.
 */
export function publicLimits(clock = Date.now) {
  const any = bucket(20, 300)
  const heavy = bucket(2, 10)
  return (request: Request) => {
    const now = clock()
    const address = request.headers.get('x-forwarded-for') ?? 'local'
    const { pathname } = new URL(request.url)
    const wait = any(address, now) || (HEAVY.test(pathname) ? heavy(address, now) : 0)
    if (!wait) return
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
      headers: { 'Cache-Control': 'no-store', 'Retry-After': String(wait) },
    })
  }
}
