/**
 * Tâche `prices` : les prix des cartes à l'unité chez Cardmarket, regardés toutes les 6 h (le
 * Cron, `index.ts`), d'après son guide des prix public (prix du jour de chaque carte, par id
 * produit) et sa liste des produits (leur nom, leur extension et leur métacarte :
 * `cardmarket_products`, d'où leur ligne pour une liste de souhaits, `/v1/wants`). Lus en flux
 * (`streamArray`) : entiers, ils ne tiendraient pas en mémoire. Le prix du jour suit la règle de
 * Pokécardex (`guidePrice`), dont l'historique est repris (`history.ts`) : les courbes sont d'un
 * seul tenant. Il remplace celui de la veille (`cardmarket_prices`, avec le prix d'il y a 30 jours,
 * d'après l'historique) et s'ajoute à l'historique de la carte (`cardmarket_history`) ; relancée le
 * même jour, la tâche remplace le prix du jour. Le guide et la liste ne sont retéléchargés que si
 * le guide a changé depuis le dernier passage (`sources`, qui donne aussi leur ETag aux réponses
 * tirées des prix).
 */

import { env } from 'cloudflare:workers'
import { monthAgoYears, priceBefore, withPrice, yearDay } from '@/lib/history'
import { addDays } from '@/lib/time'
import { journal, plural, reasonOf } from '../journal'
import { streamArray } from './json-stream'
import { download } from './net'
import { readSource, writeSource } from './sources'
import { readYears, writeYears, type YearWrite } from './years'

const DOWNLOADS = 'https://downloads.s3.cardmarket.com/productCatalog'
const PRICE_GUIDE_URL = `${DOWNLOADS}/priceGuide/price_guide_6.json`
const PRODUCTS_URL = `${DOWNLOADS}/productList/products_singles_6.json`
/** La catégorie des cartes à l'unité (« Pokémon Single ») ; les autres sont des produits scellés. */
const SINGLES = 51

/** Le guide des prix de Cardmarket (`price_guide_6.json`), ce qu'en lit la tâche. */
export interface PriceGuide {
  createdAt: string
  priceGuides: {
    idProduct: number
    idCategory: number
    low: number | null
    trend: number | null
    avg1: number | null
    avg7: number | null
    avg30: number | null
  }[]
}

/** La liste des produits de Cardmarket (`products_singles_6.json`), ce qu'en lit la tâche. */
export interface ProductList {
  products: { idProduct: number; name: string; idExpansion: number; idMetacard: number }[]
}

/** Les produits écrits par requête (le texte d'une requête : 2 Mo au plus). */
const PRODUCTS_PER_QUERY = 10_000

/**
 * Enregistre la liste des produits, d'un seul tenant : le nom, l'extension et la métacarte de
 * chacun (seules les lignes qui changent sont réécrites). Un produit qu'elle ne donne plus garde son
 * nom (son historique le montre) mais perd son extension : il ne compte plus parmi les versions de
 * sa carte (`wantsVersion`).
 */
async function saveProducts({ products }: ProductList) {
  const write = (chunk: ProductList['products']) =>
    env.DB.prepare(
      `INSERT INTO cardmarket_products (id, name, expansion, metacard)
       SELECT json_extract(value, '$.idProduct'), json_extract(value, '$.name'),
              json_extract(value, '$.idExpansion'), json_extract(value, '$.idMetacard')
       FROM json_each(?) WHERE true
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, expansion = excluded.expansion, metacard = excluded.metacard
       WHERE name != excluded.name OR expansion IS NOT excluded.expansion
         OR metacard IS NOT excluded.metacard`,
    ).bind(JSON.stringify(chunk))
  const statements = []
  for (let from = 0; from < products.length; from += PRODUCTS_PER_QUERY) {
    statements.push(write(products.slice(from, from + PRODUCTS_PER_QUERY)))
  }
  statements.push(
    env.DB.prepare(
      `UPDATE cardmarket_products SET expansion = NULL, metacard = NULL
       WHERE expansion IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(products.map(({ idProduct }) => idProduct))),
  )
  await env.DB.batch(statements)
}

/** Un prix au centime ; Cardmarket note `0` ou `null` un prix inconnu. */
const amount = (value: number | null) => (value ? Math.round(value * 100) / 100 : null)

/**
 * Le prix d'une carte d'après le guide du jour, la règle de Pokécardex (testé) : une carte d'une
 * série sortie depuis moins de 31 jours (`recent`), la tendance Cardmarket ; sinon, sa moyenne sur
 * 30 jours, à défaut sur 7 jours, puis sur 1 jour. `null` : pas de prix.
 */
function guidePrice(row: PriceGuide['priceGuides'][number], recent: boolean) {
  const average = amount(row.avg30) ?? amount(row.avg7) ?? amount(row.avg1)
  return recent ? (amount(row.trend) ?? average) : average
}

/** Le guide des prix du jour, ses cartes à l'unité seulement, et ce qu'en lit la tâche. */
async function readGuide(): Promise<PriceGuide> {
  const priceGuides: PriceGuide['priceGuides'] = []
  const rest = await streamArray<PriceGuide['priceGuides'][number]>(
    (await download(PRICE_GUIDE_URL)).body!,
    'priceGuides',
    ({ idProduct, idCategory, low, trend, avg1, avg7, avg30 }) => {
      if (idCategory === SINGLES) {
        priceGuides.push({ idProduct, idCategory, low, trend, avg1, avg7, avg30 })
      }
    },
  )
  const createdAt = /"createdAt"\s*:\s*"([^"]+)"/.exec(rest)?.[1]
  if (!createdAt) throw new Error('Guide des prix : sans date (format changé ?)')
  return { createdAt, priceGuides }
}

/** La liste des produits, ce qu'en lit la tâche. */
async function readProducts(): Promise<ProductList> {
  const products: ProductList['products'] = []
  await streamArray<ProductList['products'][number]>(
    (await download(PRODUCTS_URL)).body!,
    'products',
    ({ idProduct, name, idExpansion, idMetacard }) =>
      products.push({ idProduct, name, idExpansion, idMetacard }),
  )
  return { products }
}

export async function prices() {
  const head = await download(PRICE_GUIDE_URL, { method: 'HEAD' })
  const stamp = head.headers.get('last-modified') ?? ''
  if (stamp && stamp === (await readSource('cardmarket'))?.stamp) {
    journal({ topic: 'tâches', level: 'info', message: 'Guide des prix inchangé' })
    return
  }
  const guide = await readGuide()
  // La liste des produits ne sert qu'à la liste de souhaits : illisible (renommée, en panne), le
  // guide des prix, dont chaque jour manqué l'est pour toujours, s'enregistre sans elle.
  const products = await readProducts().catch((error: unknown) => {
    journal({
      topic: 'tâches',
      level: 'warn',
      message: 'Liste des produits illisible',
      details: { raison: reasonOf(error) },
    })
    return null
  })
  // Sans date de mise à jour (l'en-tête absent), l'heure du guide : deux guides d'un même jour
  // n'ont pas le même tampon, ni les réponses tirées des prix le même ETag.
  const saved = await savePriceGuide(guide, products, stamp || guide.createdAt)
  journal({
    topic: 'tâches',
    level: 'ok',
    message: 'Prix enregistrés',
    details: { jour: saved.date, cartes: saved.cards, historiques: saved.written },
  })
  if (saved.unsavedProducts) {
    journal({
      topic: 'tâches',
      level: 'warn',
      message: 'Liste des produits pas enregistrée',
      details: { raison: saved.unsavedProducts },
    })
  }
}

/** Les cartes dont les années sont lues et réécrites ensemble (2 Mo au plus par requête). */
const CARDS_PER_CHUNK = 200

/**
 * Enregistre le guide des prix du jour et la liste des produits : les prix du jour remplacent ceux
 * de la veille, chacun s'ajoute à l'historique de sa carte (relancée le même jour, le prix du jour
 * remplacé), et `sources` note le passage (`stamp`). Les cartes à l'unité seulement, leur prix
 * selon la règle de Pokécardex (`guidePrice` ; `0` : pas de prix), avec le prix d'il y a 30 jours
 * (`monthAgo`). Moins de la moitié des prix d'avant : rien n'est écrit, une erreur (le format a
 * changé). La liste des produits, elle, n'arrête jamais les prix (testé) : illisible (`null`),
 * tronquée (moins de la moitié des produits qu'elle donnait : sinon tous les autres perdraient leur
 * extension, et leur ligne de liste de souhaits) ou impossible à enregistrer, celle d'avant reste ;
 * `unsavedProducts` dit pourquoi (`null` : enregistrée). L'historique s'écrit par paquets de
 * cartes ; les prix du jour, mis de côté (`cardmarket_prices_next`), ne remplacent ceux de la
 * veille, avec le passage noté, qu'une fois tous écrits, d'un seul tenant : arrêtée en route, la
 * tâche n'a rien changé des prix, et relancée, elle refait l'historique du jour à l'identique.
 */
export async function savePriceGuide(
  guide: PriceGuide,
  products: ProductList | null,
  stamp: string,
) {
  const date = guide.createdAt.slice(0, 10)

  // Les cartes des séries sorties depuis moins de 31 jours, d'après le catalogue : leur prix est la
  // tendance (`guidePrice`). Le nombre de prix d'avant, et de produits de la liste d'avant.
  const [recentRows, before, listed] = await env.DB.batch([
    env.DB.prepare(
      `SELECT DISTINCT cards.cardmarket AS id
       FROM cards JOIN sets ON sets.lang = cards.lang AND sets.id = cards.set_id
       WHERE cards.cardmarket != 0 AND sets.released > ?`,
    ).bind(addDays(date, -31)),
    env.DB.prepare('SELECT COUNT(*) AS count FROM cardmarket_prices'),
    env.DB.prepare('SELECT COUNT(*) AS count FROM cardmarket_products WHERE expansion IS NOT NULL'),
  ])
  const recent = new Set((recentRows!.results as { id: number }[]).map(({ id }) => id))
  const cards: [id: number, price: number, low: number | null][] = []
  for (const row of guide.priceGuides) {
    const price = row.idCategory === SINGLES && guidePrice(row, recent.has(row.idProduct))
    if (price) cards.push([row.idProduct, price, amount(row.low)])
  }

  // Moins de la moitié des prix d'avant : le format du guide a changé (un champ renommé). Rien
  // n'est écrit ; la tâche échoue, pour être relancée.
  const count = (result: D1Result | undefined) => (result!.results[0] as { count: number }).count
  if (cards.length < count(before) / 2) {
    throw new Error(
      `Guide des prix : ${cards.length} prix, contre ${count(before)} (format changé ?)`,
    )
  }

  let unsavedProducts: string | null = null
  if (!products) unsavedProducts = 'illisible'
  else if (products.products.length < count(listed) / 2) {
    const read = plural(products.products.length, 'produit', 'produits')
    unsavedProducts = `${read}, contre ${count(listed)}`
  } else {
    await saveProducts(products).catch((error: unknown) => {
      unsavedProducts = reasonOf(error)
    })
  }

  // Les années que lit la tâche : celle du jour, et celles du prix d'il y a 30 jours.
  const years = monthAgoYears(date)
  await env.DB.prepare('DELETE FROM cardmarket_prices_next').run()
  let written = 0
  for (let from = 0; from < cards.length; from += CARDS_PER_CHUNK) {
    written += await saveChunk(cards.slice(from, from + CARDS_PER_CHUNK), date, years)
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cardmarket_prices'),
    env.DB.prepare(
      `INSERT INTO cardmarket_prices (id, price, low, month_ago)
       SELECT id, price, low, month_ago FROM cardmarket_prices_next`,
    ),
    env.DB.prepare('DELETE FROM cardmarket_prices_next'),
    writeSource('cardmarket', { stamp, date }),
  ])
  return { date, cards: cards.length, written, unsavedProducts }
}

/**
 * Le prix du jour de ces cartes ajouté à leur année (`withPrice`), leur prix et celui d'il y a
 * 30 jours mis de côté ; celles dont l'année a changé entre sa lecture et son écriture (la tâche
 * `history` y reprenait des jours) sont relues et refaites. Rend le nombre d'années réécrites.
 */
async function saveChunk(
  cards: [id: number, price: number, low: number | null][],
  date: string,
  years: number[],
) {
  const [year, day] = yearDay(date)
  let todo = cards
  let written = 0
  for (let attempt = 1; todo.length; attempt++) {
    if (attempt > 5) throw new Error('Historique changé sans cesse pendant son écriture')
    const stored = Map.groupBy(
      await readYears(
        todo.map(([id]) => id),
        years,
      ),
      ({ id }) => id,
    )
    const writes: YearWrite[] = []
    const rows = todo.map(([id, price, low]) => {
      const known = stored.get(id) ?? []
      const current = known.find((row) => row.year === year)
      const next = withPrice(current, year, day, price)
      if (next !== current) {
        const prices = JSON.stringify(next.prices)
        writes.push({ id, year, first: next.first, prices, old: current?.text ?? null })
      }
      const others = known.filter((row) => row.year !== year)
      return { id, price, low, monthAgo: priceBefore([...others, next], date) }
    })
    const changed = new Set((await writeYears(writes)).map(({ id }) => id))
    written += writes.length - changed.size
    await env.DB.prepare(
      `INSERT OR REPLACE INTO cardmarket_prices_next (id, price, low, month_ago)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.price'),
              json_extract(value, '$.low'), json_extract(value, '$.monthAgo')
       FROM json_each(?)`,
    )
      .bind(JSON.stringify(rows.filter(({ id }) => !changed.has(id))))
      .run()
    todo = todo.filter(([id]) => changed.has(id))
  }
  return written
}
