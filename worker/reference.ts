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
 *   ces trois-là ont un ETag tiré du passage de la tâche `prices` et de l'avancée de la tâche
 *   `history` (`pricesAnswer`) : un 304 tant que les prix et l'historique n'ont pas changé ;
 * - `GET /wants?ids=719621,719654` : la ligne de chaque carte Cardmarket demandée pour la liste de
 *   souhaits Cardmarket (`wantsLine`), `null` sans ligne sûre ; calculée à chaque demande.
 * Les grosses réponses sont servies telles que calculées en fin de tâche (`snapshots.ts`). Un
 * paramètre mal écrit : 422, sans rien lire.
 */

import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { snapshotName } from '@/config/catalog'
import { TOTAL_SPECIES } from '@/config/pokedex'
import type { CardLanguage, PriceFile, PriceHistories, WantsLines } from '@/contract'
import { wantsLine, type ExpansionName } from '@/lib/wants'
import { readHistories } from './history'
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
 * jour et le jour du guide) et l'avancée de la reprise de l'historique (`ingest/history.ts`) ;
 * `null` tant que les prix n'ont jamais été lus.
 */
async function pricesSource() {
  const { results } = await env.DB.prepare(
    "SELECT name, stamp, date FROM sources WHERE name IN ('cardmarket', 'history')",
  ).all<{ name: string; stamp: string; date: string }>()
  const prices = results.find(({ name }) => name === 'cardmarket')
  const history = results.find(({ name }) => name === 'history')
  return prices && { version: `${prices.stamp}|${prices.date}|${history?.stamp ?? ''}`, ...prices }
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
  read: (date: string) => Promise<unknown>,
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
 * Les produits demandés qui peuvent avoir une ligne : rangés dans une extension (sinon absents de
 * la liste des produits de Cardmarket) et sous une métacarte (sinon pas de version sûre).
 */
const WANTED = `SELECT id, name, expansion, metacard FROM cardmarket_products
  WHERE id IN (SELECT value FROM json_each(?1)) AND expansion IS NOT NULL AND metacard IS NOT NULL`

/**
 * La ligne de chaque produit Cardmarket demandé pour la liste de souhaits ; `null` sans ligne
 * sûre. En trois requêtes, quel que soit le nombre de produits : les produits ; le numéro imprimé
 * de chaque produit de la même carte (même extension, même métacarte) dans son extension, d'après
 * le catalogue (`null` : absent du catalogue, ou plusieurs numéros) ; les noms d'extension des
 * séries du catalogue de chaque extension (`expansion_name`, dans les deux langues, jamais vide),
 * chacun avec le nombre d'extensions dont des cartes du catalogue, de toute langue, portent ce nom.
 * Une série se joint à ses cartes par sa langue et son code : un code se répète d'une langue à
 * l'autre.
 */
async function readWants(ids: number[]): Promise<WantsLines> {
  const json = JSON.stringify(ids)
  const [products, sameCards, names] = await env.DB.batch([
    env.DB.prepare(WANTED).bind(json),
    env.DB.prepare(
      `SELECT products.expansion, products.metacard, products.id,
              CASE WHEN COUNT(DISTINCT cards.number) = 1 THEN MIN(cards.number) END AS number
       FROM cardmarket_products AS products LEFT JOIN cards ON cards.cardmarket = products.id
       WHERE (products.expansion, products.metacard) IN (SELECT expansion, metacard FROM (${WANTED}))
       GROUP BY products.id ORDER BY products.id`,
    ).bind(json),
    env.DB.prepare(
      `SELECT products.expansion, sets.expansion_name AS name,
              (SELECT COUNT(DISTINCT others.expansion) FROM cards AS shared
               JOIN cardmarket_products AS others ON others.id = shared.cardmarket
               -- Les séries de ce nom d'abord, puis leurs cartes (index cards_by_set).
               WHERE (shared.lang, shared.set_id) IN (SELECT lang, id FROM sets AS same
                                                      WHERE TRIM(same.expansion_name)
                                                          = TRIM(sets.expansion_name)))
              AS expansions
       FROM cardmarket_products AS products
       JOIN cards ON cards.cardmarket = products.id
       JOIN sets ON sets.lang = cards.lang AND sets.id = cards.set_id
       WHERE products.expansion IN (SELECT expansion FROM (${WANTED}))
         AND sets.expansion_name <> ''
       GROUP BY products.expansion, sets.expansion_name`,
    ).bind(json),
  ])
  const product = new Map(
    (products!.results as { id: number; name: string; expansion: number; metacard: number }[]).map(
      (row) => [row.id, row],
    ),
  )
  const group = Map.groupBy(
    sameCards!.results as {
      expansion: number
      metacard: number
      id: number
      number: string | null
    }[],
    ({ expansion, metacard }) => `${expansion}|${metacard}`,
  )
  const named = Map.groupBy(
    names!.results as ({ expansion: number } & ExpansionName)[],
    ({ expansion }) => expansion,
  )
  return Object.fromEntries(
    ids.map((id) => {
      const row = product.get(id)
      if (!row) return [id, null]
      const same = group.get(`${row.expansion}|${row.metacard}`)!
      return [
        id,
        wantsLine(
          { name: row.name, number: same.find((other) => other.id === id)!.number },
          same.map(({ number }) => number),
          named.get(row.expansion) ?? [],
        ),
      ]
    }),
  )
}

/**
 * Les trois routes du catalogue d'une langue, chacune servant sa réponse (`snapshotName`) :
 * `/catalog/…` pour les cartes japonaises, `/catalog/fr/…` pour les françaises. Le numéro d'un
 * Pokémon, de 1 à 1 025 ; le code d'une série chez Pokécardex (« SV2A », « S8A-G »).
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
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return refused()
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
    return pricesAnswer(c.req.raw, `prices:${ids.join()}`, (date) => readPrices(ids, date))
  })
  // Pas de 404 retenu : la carte peut avoir un prix au prochain passage.
  .get('/prices/:id', (c) => {
    const id = c.req.param('id')
    if (!/^[1-9]\d{0,8}$/.test(id)) return refused()
    const card = Number(id)
    return pricesAnswer(c.req.raw, `history:${id}`, async () => (await readHistories([card]))[card])
  })
  .get('/histories', (c) => {
    const ids = idsOf(c.req.query('ids'))
    if (!ids) return refused()
    return pricesAnswer(c.req.raw, `histories:${ids.join()}`, (): Promise<PriceHistories> =>
      readHistories(ids),
    )
  })
  // Sans cache : les produits et le catalogue changent avec les tâches.
  .get('/wants', async (c) => {
    const ids = idsOf(c.req.query('ids'))
    if (!ids) return refused()
    c.header('Cache-Control', 'no-cache')
    return c.json(await readWants(ids))
  })
