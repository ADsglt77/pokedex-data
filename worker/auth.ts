/**
 * Les clients de l'entrée d'Internet (`https://api.pokecodex.fr`, `index.ts`) : sans token, aucune
 * donnée. Chacun a le sien, dans `API_TOKENS` (un secret du Worker ; `.env` en développement) :
 * `nom:token,…`, un par script ou autre app, retiré d'`API_TOKENS` pour le révoquer. Un token se
 * tire au hasard (`openssl rand -hex 32`), 32 caractères au moins : sinon, le Worker ne démarre
 * pas. Chaque requête le porte (`Authorization: Bearer <token>`), comparé à temps constant à
 * chacun des tokens connus : sans lui, ou un autre, 401 sans corps, et une ligne au journal (une
 * par minute et par raison au plus). Jamais un token écrit nulle part. Le site n'en a pas besoin :
 * il joint le Worker par sa liaison de service, que personne d'autre n'a (`SiteEntrypoint`).
 */

import { env } from 'cloudflare:workers'
import { journalOnce } from './journal'

/** Un token devinable ne protège rien. */
const MIN_TOKEN = 32

/** Les clients d'`API_TOKENS` ; une erreur qui dit ce qui ne va pas. */
export function readClients(text: string) {
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
      if (token.length < MIN_TOKEN) {
        throw new Error(`API_TOKENS : le token de ${name} a moins de ${MIN_TOKEN} caractères`)
      }
      return { name, token }
    })
}

/** Lus au chargement : des tokens mal écrits, et le Worker ne démarre pas. */
const CLIENTS = readClients(env.API_TOKENS ?? '')

/** L'empreinte d'un token : les comparaisons portent sur des longueurs égales. */
const hash = async (token: string) =>
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))

/** Les empreintes des tokens connus, calculées une fois. */
let known: Promise<ArrayBuffer[]> | undefined

/** La requête porte-t-elle le token d'un client ? */
async function fromClient(request: Request) {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) return false
  const sent = await hash(token)
  known ??= Promise.all(CLIENTS.map((client) => hash(client.token)))
  // Comparé à tous, sans s'arrêter au bon : la durée ne dit pas lequel c'était.
  let found = false
  for (const client of await known) {
    if (crypto.subtle.timingSafeEqual(sent, client)) found = true
  }
  return found
}

/**
 * La garde de chaque requête de l'entrée d'Internet, avant toute route (une adresse inconnue
 * aussi : pas de 404 qui dirait ce qui existe) : rien, ou la réponse 401. `/v1/health` passe sans
 * token.
 */
export async function guard(request: Request) {
  const { pathname } = new URL(request.url)
  if (pathname === '/v1/health' || (await fromClient(request))) return
  const reason = request.headers.has('authorization') ? 'token inconnu' : 'sans token'
  journalOnce(reason, {
    topic: 'accès',
    level: 'warn',
    message: 'Token refusé',
    details: { raison: reason, route: `${request.method} ${pathname}` },
  })
  return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } })
}
