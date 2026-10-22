/**
 * Les données de référence, que remplissent les tâches d'ingestion (`ingest.ts`), sous `/v1` :
 * - `GET /species`, `/species/details` : les espèces, et ce qu'en montre la fiche ;
 * - `GET /catalog/species/:id` : les cartes Pokémon japonaises d'un Pokémon (la fenêtre d'ajout) ;
 *   `GET /catalog/sets` : les séries du catalogue ; `GET /catalog/sets/:id` : toutes les cartes
 *   d'une série, dresseurs et énergies compris (la page Catalogue) ;
 * - `GET /catalog/fr/species/:id`, `/catalog/fr/sets`, `/catalog/fr/sets/:id` : les mêmes réponses
 *   pour les cartes françaises (`catalogRoutes`), sans jamais mêler les deux langues ;
 * - `GET /prices?ids=…` : les prix Cardmarket du jour des cartes demandées, dans la forme de
 *   `readPrices` ; `GET /prices/:id` : l'historique d'une carte Cardmarket, par son id produit (la
 *   fiche) ;
 * - `GET /histories?ids=719621,719654` : l'historique de chaque carte Cardmarket demandée, `null`
 *   sans historique, en une demande (la courbe de la valeur de la collection, page Valeur) ;
 *   ces trois-là ont un ETag tiré du passage de la tâche `prices` et de l'avancée de la tâche
 *   `history` (`pricesTag`) : un 304 tant que les prix et l'historique n'ont pas changé ;
 * - `GET /wants?ids=719621,719654` : la ligne de chaque carte Cardmarket demandée pour la liste de
 *   souhaits Cardmarket (`wantsLine`), `null` sans ligne sûre ; calculée à chaque demande, chaque
 *   id et chaque extension une fois.
 * Les grosses réponses sont servies telles que calculées en fin de tâche (`snapshots.ts`).
 */

import type { Database } from 'bun:sqlite'
import { Elysia, t } from 'elysia'
import { TOTAL_SPECIES } from '@/config/pokedex'
import type { CardLanguage, PriceFile, PriceHistories, WantsLines } from '@/contract'
import { wantsLine, type ExpansionName } from '@/lib/wants'
import { historyReader } from './history'
import { readSource } from './db'
import { snapshotName } from './jobs/catalog'
import { notFound, serveSnapshot, serveTagged } from './snapshots'

/**
 * `?ids=` (`/prices`, `/histories`, `/wants`) : des ids Cardmarket séparés par des virgules, de 1 à
 * 9 chiffres chacun, sans zéro devant (un id n'a qu'une écriture : sa clé dans la réponse) ; 1 025
 * au plus, une carte par Pokémon (une collection, une commande, une extension du catalogue), et une
 * adresse que nginx accepte.
 */
const IDS = t.Object({
  ids: t.String({ pattern: `^[1-9]\\d{0,8}(,[1-9]\\d{0,8}){0,${TOTAL_SPECIES - 1}}$` }),
})

/** La réponse de chaque id demandé, une clé par id : chacun n'est lu qu'une fois, même répété. */
const eachId = <T>(ids: string, read: (id: number) => T) =>
  Object.fromEntries([...new Set(ids.split(','))].map((id) => [id, read(Number(id))]))

/**
 * Les prix Cardmarket du jour des cartes `ids`, d'après la base : une clé par carte, `null` sans
 * prix ce jour (le navigateur sait ainsi qu'elle a eu sa réponse). Lus dans la transaction de
 * `pricesAnswer`, qui répond 404 tant que le guide n'a jamais été lu.
 */
function readPrices(db: Database, ids: readonly number[]): PriceFile {
  const rows = db
    .query(
      `SELECT id, price, low, month_ago AS monthAgo FROM cardmarket_prices
       WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as {
    id: number
    price: number
    low: number | null
    monthAgo: number | null
  }[]
  const cards: PriceFile['cards'] = Object.fromEntries(ids.map((id) => [id, null]))
  for (const { id, price, low, monthAgo } of rows) cards[id] = [price, low, monthAgo]
  return { date: readSource(db, 'cardmarket')!.date, cards }
}

export function referenceRoutes(data: Database) {
  const readHistory = historyReader(data)
  // Ce que demande `wantsLine` : le produit (sans extension, absent de la liste des produits de
  // Cardmarket : pas de ligne) ; le numéro imprimé de chaque produit de la même carte dans son
  // extension, lui compris, d'après le catalogue (`null` : absent du catalogue, ou plusieurs
  // numéros) ; les noms d'extension des séries du catalogue de son extension (`expansion_name`,
  // dans les deux langues, jamais vide), chacun avec le nombre d'extensions dont des cartes du
  // catalogue, de toute langue, portent ce nom (calculé une fois par nom : `GROUP BY`). Une série
  // se joint à ses cartes par sa langue et son code : un code se répète d'une langue à l'autre.
  // Sans métacarte (un produit que Cardmarket ne range sous aucune) : pas de version sûre, donc
  // pas de ligne.
  const product = data.query(
    `SELECT name, expansion, metacard FROM cardmarket_products
     WHERE id = ? AND expansion IS NOT NULL AND metacard IS NOT NULL`,
  )
  const sameCard = data.query(
    `SELECT products.id,
            CASE WHEN COUNT(DISTINCT cards.number) = 1 THEN MIN(cards.number) END AS number
     FROM cardmarket_products AS products LEFT JOIN cards ON cards.cardmarket = products.id
     WHERE products.expansion = ? AND products.metacard = ?
     GROUP BY products.id`,
  )
  const expansionNames = data.query(
    `SELECT sets.expansion_name AS name,
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
     WHERE products.expansion = ? AND sets.expansion_name <> ''
     GROUP BY sets.expansion_name`,
  )
  /**
   * La ligne d'un produit Cardmarket pour la liste de souhaits ; `null` sans ligne sûre. `known` :
   * les noms de chaque extension déjà lus pour cette demande (la même extension revient souvent).
   */
  function wantsLineOf(id: number, known: Map<number, ExpansionName[]>) {
    const row = product.get(id) as { name: string; expansion: number; metacard: number } | null
    if (!row) return null
    const group = sameCard.all(row.expansion, row.metacard) as {
      id: number
      number: string | null
    }[]
    const names = known.get(row.expansion) ?? (expansionNames.all(row.expansion) as ExpansionName[])
    known.set(row.expansion, names)
    return wantsLine(
      { name: row.name, number: group.find((other) => other.id === id)!.number },
      group.map(({ number }) => number),
      names,
    )
  }
  /**
   * Ce dont dépend une réponse tirée des prix (`what` : ce qui est demandé), d'où son ETag : elle ne
   * change qu'avec eux, et la tâche `prices` note son passage (`sources`) dans la même transaction
   * que les prix et l'historique ; `null` tant que les prix n'ont jamais été lus.
   */
  function pricesTag(what: string) {
    const source = readSource(data, 'cardmarket')
    // L'avancée de la reprise de l'historique (`jobs/history.ts`) : ses jours se voient aussitôt.
    const history = readSource(data, 'history')
    return source && `${source.stamp}|${source.date}|${history?.stamp ?? ''}|${what}`
  }
  /**
   * Une réponse tirée des prix et son ETag, lus dans une même transaction : la tâche `prices`
   * écrivant entre les deux, des prix neufs partiraient sinon avec l'ancien ETag.
   */
  const pricesAnswer = (request: Request, what: string, read: () => unknown) =>
    data.transaction(() => {
      const tag = pricesTag(what)
      return tag ? serveTagged(request, tag, read) : notFound()
    })()
  /** Une réponse calculée en fin de tâche. */
  const snapshot =
    (name: string) =>
    ({ request }: { request: Request }) =>
      serveSnapshot(data, name, request)
  /** Sa description dans la documentation de l'API. */
  const doc = (summary: string) => ({ detail: { summary, tags: ['Référence'] } })
  /**
   * Les trois routes du catalogue d'une langue, chacune servant sa réponse (`snapshotName`) :
   * `/catalog/…` pour les cartes japonaises, `/catalog/fr/…` pour les françaises.
   */
  const catalogRoutes = (lang: CardLanguage) => {
    const cards = lang === 'ja' ? 'japonaises' : 'françaises'
    const answer = (rest: string, request: Request) =>
      serveSnapshot(data, snapshotName(lang, rest), request)
    return new Elysia({ prefix: lang === 'ja' ? '/catalog' : '/catalog/fr' })
      .get('/species/:id', ({ params, request }) => answer(`species/${params.id}`, request), {
        params: t.Object({ id: t.Integer({ minimum: 1, maximum: TOTAL_SPECIES }) }),
        ...doc(`Les cartes ${cards} d’un Pokémon`),
      })
      .get(
        '/sets',
        ({ request }) => answer('sets', request),
        doc(`Les séries du catalogue des cartes ${cards}`),
      )
      .get('/sets/:id', ({ params, request }) => answer(`sets/${params.id}`, request), {
        // Un code de série chez Pokécardex : « SV2A », « S8A-G ».
        params: t.Object({ id: t.String({ pattern: '^[A-Za-z0-9_-]{1,32}$' }) }),
        ...doc(`Toutes les cartes ${cards} d’une série`),
      })
  }

  return new Elysia({ name: 'reference' })
    .get('/species', snapshot('species'), doc('Les espèces : noms, types, génération'))
    .get(
      '/species/details',
      snapshot('species-details'),
      doc('Les détails des espèces : catégorie, description, taille…'),
    )
    .use(catalogRoutes('ja'))
    .use(catalogRoutes('fr'))
    .get(
      '/prices',
      ({ query, request }) => {
        const ids = [...new Set(query.ids.split(','))]
        return pricesAnswer(request, `prices:${ids.join()}`, () =>
          readPrices(data, ids.map(Number)),
        )
      },
      {
        query: IDS,
        ...doc('Les prix du jour de cartes Cardmarket'),
      },
    )
    .get(
      '/prices/:id',
      // Pas de 404 retenu : la carte peut avoir un prix au prochain passage.
      ({ params, request }) =>
        pricesAnswer(request, `history:${params.id}`, () => readHistory(params.id)),
      {
        params: t.Object({ id: t.Integer({ minimum: 1, maximum: 999_999_999 }) }),
        ...doc('L’historique des prix d’une carte Cardmarket'),
      },
    )
    .get(
      '/histories',
      ({ query, request }) =>
        pricesAnswer(request, `histories:${query.ids}`, (): PriceHistories =>
          eachId(query.ids, readHistory),
        ),
      {
        query: IDS,
        ...doc('Les historiques des prix de plusieurs cartes Cardmarket'),
      },
    )
    .get(
      '/wants',
      ({ query, set }): WantsLines => {
        // Sans cache : les produits et le catalogue changent avec les tâches.
        set.headers['cache-control'] = 'no-cache'
        // Chaque id une fois, chaque extension lue une fois : une demande coûte au plus un passage
        // sur les produits demandés, même répétés.
        const known = new Map<number, ExpansionName[]>()
        return eachId(query.ids, (id) => wantsLineOf(id, known))
      },
      {
        query: IDS,
        ...doc('Les lignes de cartes Cardmarket pour une liste de souhaits Cardmarket'),
      },
    )
}
