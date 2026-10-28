/**
 * Les clients de l'API : sans token, aucune donnée. Chacun a le sien, dans `API_TOKENS` (le `.env`
 * de l'API) : `nom:token,…` : `pokedex` (le site, qui le garde dans son propre `.env`,
 * `DATA_API_TOKEN`), et chaque client qui passe par `https://api.pokecodex.fr` (un script, une autre
 * app : un token chacun, retiré d'`API_TOKENS` pour le révoquer, au redémarrage de l'API). Un token
 * se tire au hasard (`openssl rand -hex 32`), 32 caractères au
 * moins en production. Chaque requête le porte (`Authorization: Bearer <token>`), comparé à temps
 * constant à chacun des tokens connus : sans lui, ou un autre, 401 sans corps, et une ligne au
 * journal (une par minute et par raison au plus). Jamais un token écrit nulle part.
 */

import { timingSafeEqual } from 'node:crypto'
import { MINUTE } from '@/lib/time'
import { journalOnce } from './journal'

/** Un client et l'empreinte de son token : les comparaisons portent sur des longueurs égales. */
export type Clients = { name: string; hash: Buffer }[]

/** Un token devinable ne protège rien : refusé en production. */
const MIN_TOKEN = 32

const hash = (token: string) => new Bun.CryptoHasher('sha256').update(token).digest()

/** Les clients d'`API_TOKENS` ; une erreur qui dit ce qui ne va pas, et l'API ne démarre pas. */
export function readClients(text: string, production: boolean): Clients {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // Coupé au premier `:` seulement : un token qui en contient un est gardé entier (sinon, son
      // début suffirait).
      const [name, ...rest] = entry.split(':')
      const token = rest.join(':')
      if (!name || !token) throw new Error('API_TOKENS : « nom:token,… »')
      if (production && token.length < MIN_TOKEN) {
        throw new Error(`API_TOKENS : le token de ${name} a moins de ${MIN_TOKEN} caractères`)
      }
      return { name, hash: hash(token) }
    })
}

/** Le client dont la requête porte le token ; `null` sans token, ou un inconnu. */
function clientOf(clients: Clients, request: Request) {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) return null
  const sent = hash(token)
  // Comparé à tous, sans s'arrêter au bon : la durée ne dit pas lequel c'était.
  let found: string | null = null
  for (const { name, hash: known } of clients) {
    if (timingSafeEqual(sent, known)) found = name
  }
  return found
}

/**
 * La garde de chaque requête, avant toute route (une adresse inconnue aussi : pas de 404 qui
 * dirait ce qui existe) : rien, ou la réponse 401. `/v1/health` passe sans token.
 */
export function guard(clients: Clients, request: Request) {
  const { pathname } = new URL(request.url)
  if (pathname === '/v1/health' || clientOf(clients, request)) return
  const reason = request.headers.has('authorization') ? 'token inconnu' : 'sans token'
  journalOnce(
    reason,
    {
      topic: 'accès',
      level: 'warn',
      message: 'Token refusé',
      details: { raison: reason, route: `${request.method} ${pathname}` },
    },
    MINUTE,
  )
  return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } })
}
