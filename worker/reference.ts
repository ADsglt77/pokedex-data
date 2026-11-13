/**
 * Les données de référence, que remplissent les tâches d'ingestion, sous `/v1` :
 * - `GET /species`, `/species/details` : les espèces, et ce qu'en montre la fiche ;
 * - `GET /catalog/species/:id` : les cartes Pokémon japonaises d'un Pokémon (la fenêtre d'ajout) ;
 *   `GET /catalog/sets` : les séries du catalogue ; `GET /catalog/sets/:id` : toutes les cartes
 *   d'une série, dresseurs et énergies compris (la page Catalogue) ;
 * - `GET /catalog/fr/species/:id`, `/catalog/fr/sets`, `/catalog/fr/sets/:id` : les mêmes réponses
 *   pour les cartes françaises (`catalogRoutes`), sans jamais mêler les deux langues ;
 * - `GET /prices?ids=…` : les prix Cardmarket du jour des cartes demandées (`PriceFile`) ;
 *   `GET /prices/:id` : l'historique d'une carte Cardmarket, par son id produit (la fiche) ;
 * - `GET /histories?ids=719621,719654` : l'historique de chaque carte Cardmarket demandée, `null`
 *   sans historique, en une demande (la courbe de la valeur de la collection, page Valeur) ;
 *   ces trois-là ont un ETag tiré du passage de la tâche `prices` (`pricesAnswer`) : un 304 tant
 *   que les prix n'ont pas changé ;
 * - `GET /wants?ids=719621,719654` : la ligne de chaque carte Cardmarket demandée pour la liste de
 *   souhaits Cardmarket, `null` sans ligne sûre : aujourd'hui toujours `null` (`/wants`, plus bas).
 * Les grosses réponses sont servies telles que calculées en fin de tâche (`snapshots.ts`). Un
 * paramètre mal écrit : 422, sans rien lire.
 */

import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { SET_ID, snapshotName } from '@/config/catalog'
import { TOTAL_SPECIES } from '@/config/pokedex'
import type { CardLanguage, PriceFile, WantsLines } from '@/contract'
import { readHistories, readHistoriesText } from './history'
import { readSource } from './ingest/sources'
import { notFound, serveSnapshot, serveTagged } from './snapshots'

/**
 * `?ids=` (`/prices`, `/histories`, `/wants`) : des ids Cardmarket séparés par des virgules, de 1 à
 * 9 chiffres chacun, sans zéro devant (un id n'a qu'une écriture : sa clé dans la réponse) ; 1 025
 * au plus, une carte par Pokémon (une collection, une commande, une extension du catalogue).
 */
const IDS = new RegExp(`^[1-9]\\d{0,8}(,[1-9]\\d{0,8}){0,${TOTAL_SPECIES - 1}}$`)

/** Un paramètre refusé : 422, sans corps. */
const refused = () => new Response(null, { status: 422, headers: { 'Cache-Control': 'no-store' } })

/** Les ids de `?ids=` (`IDS`), chacun une fois, même répété ; `null` s'il est mal écrit. */
const idsOf = (ids = '') => (IDS.test(ids) ? [...new Set(ids.split(','))].map(Number) : null)

/**
 * Ce dont dépend une réponse tirée des prix : le passage de la tâche `prices` (sa date de mise à
 * jour et le jour du guide) ; `null` tant que les prix n'ont jamais été lus.
 */
async function pricesSource() {
  const prices = await readSource('cardmarket')
  return prices && { version: `${prices.stamp}|${prices.date}`, ...prices }
}

/**
 * Une réponse tirée des prix (`what` : ce qui est demandé) et son ETag, qui ne change qu'avec eux ;
 * 404 tant qu'ils n'ont jamais été lus. L'ETag est lu avant la réponse : une tâche qui écrit entre
 * les deux donne au pire des prix neufs sous l'ancien ETag, relus à la demande suivante, jamais
 * d'anciens prix sous le nouveau.
 */
async function pricesAnswer(
  request: Request,
  what: string,
  read: (date: string) => Promise<string | null>,
) {
  const source = await pricesSource()
  if (!source) return notFound()
  return serveTagged(request, `${source.version}|${what}`, () => read(source.date))
}

/**
 * Les prix Cardmarket du jour des cartes `ids`, d'après la base : une clé par carte, `null` sans
 * prix ce jour (le navigateur sait ainsi qu'elle a eu sa réponse).
 */
async function readPrices(ids: number[], date: string): Promise<PriceFile> {
  const { results } = await env.DB.prepare(
    `SELECT id, price, low, month_ago AS monthAgo FROM cardmarket_prices
     WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: number; price: number; low: number | null; monthAgo: number | null }>()
  const cards: PriceFile['cards'] = Object.fromEntries(ids.map((id) => [id, null]))
  for (const { id, price, low, monthAgo } of results) cards[id] = [price, low, monthAgo]
  return { date, cards }
}

/**
 * Les trois routes du catalogue d'une langue, chacune servant sa réponse (`snapshotName`) :
 * `/catalog/…` pour les cartes japonaises, `/catalog/fr/…` pour les françaises. Le numéro d'un
 * Pokémon, de 1 à 1 025 ; l'id d'une série chez TCGdex (« SV2a », « sv03.5 », « SM1+ » : `SET_ID`).
 */
const catalogRoutes = (lang: CardLanguage) =>
  new Hono()
    .get('/species/:id', (c) => {
      const id = c.req.param('id')
      if (!/^\d{1,4}$/.test(id) || Number(id) < 1 || Number(id) > TOTAL_SPECIES) return refused()
      return serveSnapshot(snapshotName(lang, `species/${id}`), c.req.raw)
    })
    .get('/sets', (c) => serveSnapshot(snapshotName(lang, 'sets'), c.req.raw))
    .get('/sets/:id', (c) => {
      const id = c.req.param('id')
      if (!SET_ID.test(id)) return refused()
      return serveSnapshot(snapshotName(lang, `sets/${id}`), c.req.raw)
    })

export const referenceRoutes = new Hono()
  .get('/species', (c) => serveSnapshot('species', c.req.raw))
  .get('/species/details', (c) => serveSnapshot('species-details', c.req.raw))
  .route('/catalog', catalogRoutes('ja'))
  .route('/catalog/fr', catalogRoutes('fr'))
  .get('/prices', (c) => {
    const ids = idsOf(c.req.query('ids'))
    if (!ids) return refused()
    return pricesAnswer(c.req.raw, `prices:${ids.join()}`, async (date) =>
      JSON.stringify(await readPrices(ids, date)),
    )
  })
  // Pas de 404 retenu : la carte peut avoir un prix au prochain passage.
  .get('/prices/:id', (c) => {
    const id = c.req.param('id')
    if (!/^[1-9]\d{0,8}$/.test(id)) return refused()
    const card = Number(id)
    return pricesAnswer(
      c.req.raw,
      `history:${id}`,
      async () => (await readHistories([card])).get(card) ?? null,
    )
  })
  .get('/histories', (c) => {
    const ids = idsOf(c.req.query('ids'))
    if (!ids) return refused()
    return pricesAnswer(c.req.raw, `histories:${ids.join()}`, () => readHistoriesText(ids))
  })
  // Aucune ligne n'est sûre aujourd'hui (décision du 13 novembre 2026, `docs/donnees.md`, « Liste
  // de souhaits ») : une ligne doit nommer l'extension Cardmarket de la carte, en anglais, et ce nom
  // n'est dans aucune source convenue (ni le fichier des produits de Cardmarket, ni TCGdex, dont
  // les séries japonaises ont leur nom japonais et les françaises leur nom français, avec au plus
  // le code de l'extension dans le jeu en ligne). Une ligne sans lui ajouterait « n'importe quelle
  // version », peut-être une autre carte. Chaque carte a donc `null` : le site propose de
  // l'ajouter depuis sa page Cardmarket. Sans cache : une ligne sûre pourra venir avec une source.
  .get('/wants', (c) => {
    const ids = idsOf(c.req.query('ids'))
    if (!ids) return refused()
    c.header('Cache-Control', 'no-cache')
    return c.json<WantsLines>(Object.fromEntries(ids.map((id) => [id, null])))
  })
