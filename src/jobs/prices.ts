/**
 * Tâche `prices` : les prix des cartes à l'unité chez Cardmarket, regardés toutes les 6 h, d'après
 * son guide des prix public (prix du jour de chaque carte, par id produit) et sa liste des
 * produits (leur nom, leur extension et leur métacarte : `cardmarket_products`, d'où leur ligne
 * pour une liste de souhaits, `/v1/wants`). Le prix du jour suit la règle de Pokécardex
 * (`guidePrice`), dont l'historique est repris (`jobs/history.ts`) : les courbes sont d'un seul
 * tenant. Il remplace celui de la veille (`cardmarket_prices`, avec le prix d'il y a 30 jours,
 * d'après l'historique) et s'ajoute à l'historique de la carte (`cardmarket_history`) ; relancée
 * le même jour, la tâche remplace le prix du jour. Le guide et la liste ne sont retéléchargés que si
 * le guide a changé depuis le dernier passage (`sources`, qui donne aussi leur ETag aux réponses
 * tirées des prix). L'API lit les prix des seules cartes demandées (`readPrices`, `reference.ts` :
 * `/v1/prices`).
 */

import type { Database } from 'bun:sqlite'
import { addDays } from '@/lib/time'
import { readSource, writeSource } from '../db'
import { historyStore, withPrice, yearDay } from '../history'
import { download } from '../lib/net'

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

/**
 * Enregistre la liste des produits : le nom, l'extension et la métacarte de chacun. Un produit
 * qu'elle ne donne plus garde son nom (son historique le montre) mais perd son extension : il ne
 * compte plus parmi les versions de sa carte (`wantsVersion`).
 */
function saveProducts(db: Database, { products }: ProductList) {
  // Seules les lignes qui changent sont réécrites : la liste compte plus de 70 000 produits.
  const write = db.query(
    `INSERT INTO cardmarket_products (id, name, expansion, metacard) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, expansion = excluded.expansion, metacard = excluded.metacard
     WHERE name != excluded.name OR expansion IS NOT excluded.expansion
       OR metacard IS NOT excluded.metacard`,
  )
  for (const { idProduct, name, idExpansion, idMetacard } of products) {
    write.run(idProduct, name, idExpansion, idMetacard)
  }
  db.query(
    `UPDATE cardmarket_products SET expansion = NULL, metacard = NULL
     WHERE expansion IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?))`,
  ).run(JSON.stringify(products.map(({ idProduct }) => idProduct)))
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

export async function prices(db: Database) {
  const head = await download(PRICE_GUIDE_URL, { method: 'HEAD' })
  const stamp = head.headers.get('last-modified') ?? ''
  if (stamp && stamp === readSource(db, 'cardmarket')?.stamp) {
    console.log('Cardmarket : guide des prix inchangé depuis le dernier passage.')
    return
  }

  const [guide, products] = await Promise.all([
    download(PRICE_GUIDE_URL).then((response) => response.json() as Promise<PriceGuide>),
    download(PRODUCTS_URL).then((response) => response.json() as Promise<ProductList>),
  ])
  // Sans date de mise à jour (l'en-tête absent), l'heure du guide : deux guides d'un même jour
  // n'ont pas le même tampon, ni les réponses tirées des prix le même ETag.
  const { date, cards, written } = savePriceGuide(db, guide, products, stamp || guide.createdAt)
  console.log(`Cardmarket, prix du ${date} : ${cards} cartes, ${written} historiques mis à jour`)
}

/**
 * Enregistre le guide des prix du jour et la liste des produits, en une transaction : les prix du
 * jour remplacent ceux de la veille, chacun s'ajoute à l'historique de sa carte (relancée le même
 * jour, le prix du jour remplacé), et `sources` note le passage (`stamp`). Les cartes à l'unité
 * seulement, leur prix selon la règle de Pokécardex (`guidePrice` ; `0` : pas de prix), avec le
 * prix d'il y a 30 jours (`monthAgo`). Moins de la moitié des prix d'avant : rien n'est écrit,
 * une erreur (le format a changé).
 */
export function savePriceGuide(
  db: Database,
  guide: PriceGuide,
  products: ProductList,
  stamp: string,
) {
  const date = guide.createdAt.slice(0, 10)
  const [year, day] = yearDay(date)

  // Les cartes des séries sorties depuis moins de 31 jours, d'après le catalogue : leur prix est
  // la tendance (`guidePrice`).
  const recent = new Set(
    (
      db
        .query(
          `SELECT DISTINCT cards.cardmarket AS id FROM cards JOIN sets ON sets.id = cards.set_id
           WHERE cards.cardmarket != 0 AND sets.released > ?`,
        )
        .all(addDays(date, -31)) as { id: number }[]
    ).map(({ id }) => id),
  )
  const cards: [id: number, price: number, low: number | null][] = []
  for (const row of guide.priceGuides) {
    const price = row.idCategory === SINGLES && guidePrice(row, recent.has(row.idProduct))
    if (price) cards.push([row.idProduct, price, amount(row.low)])
  }

  // Moins de la moitié des prix d'avant : le format du guide a changé (un champ renommé). Rien
  // n'est écrit ; la tâche échoue, pour être relancée.
  const before = (
    db.query('SELECT COUNT(*) AS count FROM cardmarket_prices').get() as {
      count: number
    }
  ).count
  if (cards.length < before / 2) {
    throw new Error(`Guide des prix : ${cards.length} prix, contre ${before} (format changé ?)`)
  }

  const store = historyStore(db)
  const writePrice = db.query(
    'INSERT INTO cardmarket_prices (id, price, low, month_ago) VALUES (?, ?, ?, ?)',
  )
  let written = 0
  db.transaction(() => {
    saveProducts(db, products)
    db.run('DELETE FROM cardmarket_prices')
    for (const [id, price, low] of cards) {
      const known = store.year(id, year)
      const next = withPrice(known, year, day, price)
      if (next !== known) {
        store.save(id, next)
        written++
      }
      writePrice.run(id, price, low, store.monthAgo(id, date))
    }
    writeSource(db, 'cardmarket', { stamp, date })
  })()
  return { date, cards: cards.length, written }
}
