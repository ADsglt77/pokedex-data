/**
 * Tâche `catalog`, chaque jour (le Cron, `index.ts`) : le catalogue des cartes japonaises, puis des
 * françaises, d'après TCGdex, tel que l'importateur `pokecodex-importer` (dépôt `../pokecodex-api`)
 * le copie dans sa base (`CARDS`, lue seulement) et ses images dans R2 : aucune requête vers TCGdex
 * ici. Pokémon, dresseurs et énergies de chaque série, sauf celles de Pokémon TCG Pocket (des
 * cartes numériques : `EXCLUDED_SERIES`) et les cartes que TCGdex ne liste plus (`removed_at`).
 * Les champs du détail de chaque carte (`metadata_json`, le document de TCGdex) sont extraits par
 * la base elle-même (`json_extract`), page par page : jamais tous les détails en mémoire (le Worker
 * a 128 Mo). Une carte dont l'importateur n'a pas encore lu le détail (`metadata_json` vide : la
 * plupart des japonaises le 13 novembre 2026) est gardée dans sa série, sans Pokémon, type, rareté,
 * versions ni id Cardmarket : elle les aura au passage qui suit leur lecture.
 *
 * Une étape par langue (`Step`) : les réponses de la langue, dans R2 (`/v1/catalog/species/<n°>`,
 * `/v1/catalog/sets`, `/v1/catalog/sets/<id>` ; en français, `/v1/catalog/fr/…`), seulement
 * celles qui ont changé (`saveSnapshot`), celles des séries qui n'ont plus de cartes retirées ; et
 * le miroir de ses cartes (`catalog_cards`, ce que lit la tâche `prices`). Une langue sans aucune
 * carte, ou avec moins de la moitié des cartes de son miroir (la base de l'importateur vidée, son
 * format changé), n'écrit rien : la tâche échoue, après l'autre langue.
 */

import { env } from 'cloudflare:workers'
import {
  CATEGORIES,
  ENERGY_TYPES,
  EXCLUDED_SERIES,
  FIRST_EDITION,
  FIRST_EDITION_STAMPS,
  POKEMON_TYPES,
  RARITIES,
  SET_ID,
  snapshotName,
  TRAINER_TYPES,
  UNKNOWN_RARITY_RANK,
  VERSION_FLAGS,
  VERSIONS,
} from '@/config/catalog'
import { SPECIES_IDS, TOTAL_SPECIES } from '@/config/pokedex'
import type {
  CardLanguage,
  CardType,
  CatalogFile,
  CatalogRow,
  CatalogSetFile,
  CatalogSetRow,
  CatalogSetsFile,
  ImageKey,
} from '@/contract'
import { importedKey } from '@/lib/image-paths'
import { taskJournal } from '../journal'
import { removeSnapshots, saveSnapshot } from '../snapshots'
import { mapPool } from './net'
import type { Alive, Step } from './workflow'

/** Les langues du catalogue, dans l'ordre de leur lecture. */
const LANGUAGES: CardLanguage[] = ['ja', 'fr']

/** Une série, telle que la lit la tâche dans la base de l'importateur. */
interface SetRow {
  id: string
  name: string
  released: string | null
  official: number | null
  logo: string | null
  series: string | null
  block: string | null
}

/** Une carte, telle que la lit la tâche : ses colonnes, et ce que la base extrait de son détail. */
interface CardRow {
  tcgdexId: string
  set: string
  number: string
  name: string
  illustrator: string | null
  rarity: string | null
  category: string | null
  image: string | null
  dexIds: string | null
  pokemonType: string | null
  trainerType: string | null
  energyType: string | null
  variants: string | null
  flags: string | null
}

/** Une série du catalogue. */
interface CatalogSet {
  id: string
  name: string
  released: string
  logo: ImageKey
  /** Sa série chez TCGdex (son bloc) : son id et son nom ; `null` sans. */
  series: string | null
  block: string | null
}

/** Une carte du catalogue, avec sa série (son id). */
interface Card extends CatalogSetRow {
  set: string
}

/**
 * Les séries d'une langue, hors des séries de TCGdex écartées (`EXCLUDED_SERIES`) : leur logo
 * seulement s'il est copié (`logo_status`, que l'importateur remplit ; nul : aucun).
 */
const SETS = `
  SELECT sets.tcgdex_id AS id, sets.name, sets.release_date AS released,
         sets.official_cards AS official,
         CASE WHEN sets.logo_status = 'downloaded' THEN sets.logo_r2_key END AS logo,
         series.id AS series, series.name AS block
  FROM sets LEFT JOIN series ON series.id = sets.series_id
  WHERE sets.language = ?1
    AND COALESCE(series.tcgdex_id, '') NOT IN (SELECT value FROM json_each(?2))`

/**
 * Une page des cartes d'une langue (`?4` cartes après l'id TCGdex `?3`, dans l'ordre de l'index
 * `(language, tcgdex_id)` de l'importateur), hors des séries écartées et des cartes retirées : leur
 * image seulement si elle est copiée, et ce qu'en lit le catalogue dans leur détail.
 */
const CARDS = `
  SELECT cards.tcgdex_id AS tcgdexId, sets.tcgdex_id AS 'set', cards.local_id AS number,
         cards.name, cards.illustrator, cards.rarity, cards.category,
         CASE WHEN cards.image_status IN ('downloaded', 'recovered_from_cdn', 'already_present')
              THEN cards.image_r2_key END AS image,
         json_extract(cards.metadata_json, '$.dexId') AS dexIds,
         json_extract(cards.metadata_json, '$.types[0]') AS pokemonType,
         json_extract(cards.metadata_json, '$.trainerType') AS trainerType,
         json_extract(cards.metadata_json, '$.energyType') AS energyType,
         json_extract(cards.metadata_json, '$.variants_detailed') AS variants,
         json_extract(cards.metadata_json, '$.variants') AS flags
  FROM cards JOIN sets ON sets.id = cards.set_id
  LEFT JOIN series ON series.id = sets.series_id
  WHERE cards.language = ?1 AND cards.tcgdex_id > ?3 AND cards.removed_at IS NULL
    AND COALESCE(series.tcgdex_id, '') NOT IN (SELECT value FROM json_each(?2))
  ORDER BY cards.tcgdex_id LIMIT ?4`

/** Les cartes lues par requête : quelques Mo au plus (leurs versions comprises). */
const CARDS_PER_PAGE = 2000

/** Un document JSON de TCGdex (extrait par la base) ; `null` s'il n'y en a pas. */
const parsed = (json: string | null): unknown => (json === null ? null : JSON.parse(json))

/** Un tableau d'un document de TCGdex ; vide s'il n'en est pas un. */
const listOf = (json: string | null) => {
  const value = parsed(json)
  return Array.isArray(value) ? (value as unknown[]) : []
}

/** La sortie d'une série, YYYY-MM-DD ; '' si TCGdex ne la donne pas ainsi. */
const releasedOf = (raw: string | null) => /^\d{4}-\d{2}-\d{2}/.exec(raw ?? '')?.[0] ?? ''

/**
 * Le numéro tel qu'imprimé : `localId/nombre officiel` (« 006/165 », le nombre écrit avec autant
 * de chiffres que le numéro), quand la série a un nombre officiel de cartes et que le numéro n'est
 * fait que de chiffres ; sinon le numéro seul (« TG01 », une promo).
 */
const printedOf = (number: string, official: number | null) =>
  official && official > 0 && /^\d+$/.test(number)
    ? `${number}/${String(official).padStart(number.length, '0')}`
    : number

/**
 * L'ordre des cartes d'une série : par le nombre en tête de leur numéro (« 006 » : 6), celles qui
 * n'en ont pas après (« TG01 »), puis par le numéro, ses nombres comparés en nombres (« BW9 »
 * avant « BW10 »).
 */
const leadingNumber = (number: string) => Number(/^\d+/.exec(number)?.[0] ?? Infinity)
const byNumber = (a: string, b: string) =>
  leadingNumber(a) - leadingNumber(b) || a.localeCompare(b, 'en', { numeric: true })

/** Un id Cardmarket de TCGdex : un entier positif ; sinon aucun (0). */
const productOf = (variant: unknown) => {
  const id = (variant as { thirdParty?: { cardmarket?: unknown } } | null)?.thirdParty?.cardmarket
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : 0
}

/** Le type d'une version de TCGdex (« Normal », « reverse »…), en minuscules ; '' sans. */
const variantType = (variant: unknown) => {
  const type = (variant as { type?: unknown } | null)?.type
  return typeof type === 'string' ? type.toLowerCase() : ''
}

/**
 * L'id Cardmarket d'une carte : celui de sa version normale sans tampon s'il y en a un (une version
 * tamponnée, « Pokémon Center »…, est souvent un autre produit), sinon d'une version normale, sinon
 * de la première version qui en a un ; 0 sinon.
 */
function cardmarketOf(variants: unknown[]) {
  const sold = variants.filter(productOf)
  const normal = sold.filter((variant) => variantType(variant) === 'normal')
  const stamped = (variant: unknown) => !!(variant as { stamp?: unknown }).stamp
  return productOf(normal.find((variant) => !stamped(variant)) ?? normal[0] ?? sold[0])
}

/**
 * Ses versions, en français (`VERSIONS`), dans l'ordre de TCGdex, chacune une fois ; et la
 * première édition, si l'une porte son tampon. Sans versions détaillées, d'après les drapeaux de
 * TCGdex (`variants`).
 */
function versionsOf(variants: unknown[], flags: unknown) {
  const names = variants.length
    ? variants.flatMap((variant) => {
        const raw = (variant as { type?: unknown } | null)?.type
        const name = VERSIONS.get(variantType(variant)) ?? (typeof raw === 'string' ? raw : '')
        const stamps = (variant as { stamp?: unknown } | null)?.stamp
        const first =
          Array.isArray(stamps) && stamps.some((stamp) => FIRST_EDITION_STAMPS.has(stamp))
        return first ? [name, FIRST_EDITION] : [name]
      })
    : VERSION_FLAGS.filter(
        ([flag]) => (flags as Record<string, unknown> | null)?.[flag] === true,
      ).map(([, name]) => name)
  return [...new Set(names.filter(Boolean))]
}

/** Le type d'une carte (`CardType`), d'après sa catégorie ; '' sans catégorie (détail pas lu). */
function typeOf(row: CardRow): CardType {
  switch (CATEGORIES.get(row.category ?? '')) {
    case 'pokemon':
      return POKEMON_TYPES.get(row.pokemonType ?? '') ?? ''
    case 'trainer':
      return TRAINER_TYPES.get(row.trainerType ?? '') ?? 'trainer'
    case 'energy':
      return ENERGY_TYPES.get(row.energyType ?? '') ?? 'energy'
    default:
      return ''
  }
}

/** Ses Pokémon : les numéros du Pokédex national de son détail (`dexId`), de 1 à 1 025, une fois. */
const dexIdsOf = (json: string | null) => [
  ...new Set(
    listOf(json).filter(
      (id): id is number =>
        Number.isInteger(id) && (id as number) >= 1 && (id as number) <= TOTAL_SPECIES,
    ),
  ),
]

/** Une carte du catalogue, d'après sa ligne de l'importateur. */
function cardOf(lang: CardLanguage, row: CardRow, official: number | null): Card {
  const variants = listOf(row.variants)
  return {
    set: row.set,
    number: row.number,
    printed: printedOf(row.number, official),
    name: row.name,
    dexIds: dexIdsOf(row.dexIds),
    cardmarket: cardmarketOf(variants),
    image: importedKey('card', lang, row.image),
    rarity: row.rarity ?? '',
    type: typeOf(row),
    illustrator: row.illustrator ?? '',
    versions: versionsOf(variants, parsed(row.flags)),
  }
}

/**
 * Les séries et les cartes d'une langue, d'après la base de l'importateur : seulement les séries
 * qui ont des cartes, et dont l'id peut nommer une réponse (`SET_ID` ; les autres sont comptées,
 * `skipped`), et le nombre de cartes dont l'importateur n'a pas encore lu le détail
 * (`withoutDetail`). Les cartes lues page par page, chacune redisant le signe de vie de l'étape.
 */
async function readLanguage(lang: CardLanguage, alive: Alive) {
  const excluded = JSON.stringify(EXCLUDED_SERIES)
  const { results: setRows } = await env.CARDS.prepare(SETS).bind(lang, excluded).all<SetRow>()
  const official = new Map(setRows.map((set) => [set.id, set.official]))
  const cards: Card[] = []
  let withoutDetail = 0
  for (let after = ''; ;) {
    const { results } = await env.CARDS.prepare(CARDS)
      .bind(lang, excluded, after, CARDS_PER_PAGE)
      .all<CardRow>()
    for (const row of results) {
      cards.push(cardOf(lang, row, official.get(row.set) ?? null))
      if (row.category === null) withoutDetail++
    }
    await alive()
    if (results.length < CARDS_PER_PAGE) break
    after = results.at(-1)!.tcgdexId
  }
  const listed = new Set(cards.map((card) => card.set))
  const sets = setRows
    .filter((set) => listed.has(set.id))
    .map((set): CatalogSet => ({
      id: set.id,
      name: set.name,
      released: releasedOf(set.released),
      logo: importedKey('logo', lang, set.logo),
      series: set.series,
      block: set.block,
    }))
  const named = sets.filter((set) => SET_ID.test(set.id))
  const kept = new Set(named.map((set) => set.id))
  return {
    sets: named,
    cards: cards.filter((card) => kept.has(card.set)),
    skipped: sets.length - named.length,
    withoutDetail,
  }
}

/** Les raretés de ces cartes : `[nom en français, rang]` par rareté telle que l'écrit TCGdex. */
const raritiesOf = (cards: Card[]): CatalogFile['rarities'] =>
  Object.fromEntries(
    [...new Set(cards.map((card) => card.rarity))]
      .filter(Boolean)
      .map((rarity) => [rarity, RARITIES.get(rarity) ?? [rarity, UNKNOWN_RARITY_RANK]]),
  )

/** Une carte Pokémon, telle que la donne `/v1/catalog/species/<n°>`. */
function catalogRow(card: Card): CatalogRow {
  const row: CatalogRow = [
    card.set,
    card.number,
    card.cardmarket,
    card.name,
    card.image,
    card.rarity,
    card.type,
  ]
  if (card.dexIds.length > 1) row.push(card.dexIds)
  return row
}

/** Une carte d'une série, telle que la donne `/v1/catalog/sets/<id>` (sans sa série). */
const setRow = ({ set, ...card }: Card): CatalogSetRow => card

/**
 * Les réponses du catalogue d'une langue (`[nom, données]`) : chaque Pokémon, même sans carte (la
 * fenêtre d'ajout dit alors qu'il n'en a pas), ses cartes des plus récentes aux plus anciennes et,
 * dans une série, de la dernière à la première ; les séries, des plus récentes aux plus anciennes,
 * avec leurs blocs (leur série chez TCGdex, des plus récents aux plus anciens) ; chaque série, ses
 * cartes dans son ordre (`byNumber`).
 */
function catalogResponses(lang: CardLanguage, sets: CatalogSet[], cards: Card[]) {
  // Sorties le même jour : dans l'ordre de leur id.
  const ordered = sets.toSorted(
    (a, b) => b.released.localeCompare(a.released) || a.id.localeCompare(b.id),
  )
  const rank = new Map(ordered.map((set, index) => [set.id, index]))
  const byId = new Map(ordered.map((set) => [set.id, set]))
  const bySet = Map.groupBy(
    cards.toSorted((a, b) => byNumber(a.number, b.number)),
    (card) => card.set,
  )
  // Les blocs, dans l'ordre de leur série la plus récente ; chaque série renvoie au sien par son rang.
  const series = [...new Set(ordered.map((set) => set.series).filter((id) => id !== null))]
  const blocks = series.map((id) => ordered.find((set) => set.series === id)!.block ?? '')
  const setsFile: CatalogSetsFile = {
    blocks,
    sets: ordered.map((set) => [
      set.id,
      set.name,
      set.released,
      set.logo,
      bySet.get(set.id)!.length,
      set.series === null ? -1 : series.indexOf(set.series),
    ]),
  }
  const newestFirst = cards.toSorted(
    (a, b) => rank.get(a.set)! - rank.get(b.set)! || byNumber(b.number, a.number),
  )
  const bySpecies = new Map<number, Card[]>()
  for (const card of newestFirst) {
    for (const dexId of card.dexIds) {
      const own = bySpecies.get(dexId)
      if (own) own.push(card)
      else bySpecies.set(dexId, [card])
    }
  }
  const speciesFile = (dexId: number): CatalogFile => {
    const own = bySpecies.get(dexId) ?? []
    return {
      sets: Object.fromEntries(
        [...new Set(own.map((card) => card.set))].map((id) => {
          const { name, released, logo } = byId.get(id)!
          return [id, [name, released, logo]]
        }),
      ),
      cards: own.length ? { [dexId]: own.map(catalogRow) } : {},
      rarities: raritiesOf(own),
    }
  }
  return [
    ...SPECIES_IDS.map((id): [string, unknown] => [
      snapshotName(lang, `species/${id}`),
      speciesFile(id),
    ]),
    [snapshotName(lang, 'sets'), setsFile] as [string, unknown],
    ...ordered.map((set): [string, unknown] => {
      const own = bySet.get(set.id)!
      const file: CatalogSetFile = { cards: own.map(setRow), rarities: raritiesOf(own) }
      return [snapshotName(lang, `sets/${set.id}`), file]
    }),
  ]
}

/** Les cartes du miroir écrites par requête (le texte d'un paramètre : 2 Mo au plus). */
const MIRROR_PER_QUERY = 5000

/**
 * Le miroir des cartes d'une langue (`catalog_cards`), d'un seul tenant : chaque carte, son id
 * Cardmarket et la sortie de sa série (seules les lignes qui changent sont réécrites) ; celles qui
 * ne sont plus au catalogue, retirées.
 */
async function saveMirror(lang: CardLanguage, sets: CatalogSet[], cards: Card[]) {
  const released = new Map(sets.map((set) => [set.id, set.released]))
  const rows = cards.map((card) => [card.set, card.number, card.cardmarket, released.get(card.set)])
  const write = env.DB.prepare(
    `INSERT INTO catalog_cards (lang, set_id, number, cardmarket, released)
     SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
            json_extract(value, '$[2]'), json_extract(value, '$[3]')
     FROM json_each(?2) WHERE true
     ON CONFLICT (lang, set_id, number) DO UPDATE SET
       cardmarket = excluded.cardmarket, released = excluded.released
     WHERE cardmarket != excluded.cardmarket OR released != excluded.released`,
  )
  const statements = []
  for (let from = 0; from < rows.length; from += MIRROR_PER_QUERY) {
    statements.push(write.bind(lang, JSON.stringify(rows.slice(from, from + MIRROR_PER_QUERY))))
  }
  statements.push(
    env.DB.prepare(
      `DELETE FROM catalog_cards WHERE lang = ?1
       AND (set_id, number) NOT IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
                                   FROM json_each(?2))`,
    ).bind(lang, JSON.stringify(rows.map(([set, number]) => [set, number]))),
  )
  await env.DB.batch(statements)
}

/** Les séries d'une langue, dans le journal : « séries japonaises ». */
const LANGUAGE_NAMES: Record<CardLanguage, string> = { ja: 'japonaises', fr: 'françaises' }

/**
 * Le catalogue d'une langue : ses réponses et son miroir ; `refused`, la raison pour laquelle rien
 * n'est écrit (aucune carte, ou moins de la moitié de celles du miroir), `null` sinon.
 */
export async function saveLanguage(lang: CardLanguage, alive: Alive) {
  const { sets, cards, skipped, withoutDetail } = await readLanguage(lang, alive)
  const before = (await env.DB.prepare('SELECT COUNT(*) AS count FROM catalog_cards WHERE lang = ?')
    .bind(lang)
    .first<{ count: number }>())!.count
  if (!cards.length || cards.length < before / 2) {
    const refused = `Cartes ${LANGUAGE_NAMES[lang]} : ${cards.length}, contre ${before} (base de l'importateur vide ou changée ?)`
    taskJournal('warn', 'Catalogue gardé', { raison: refused })
    return { refused }
  }
  await saveMirror(lang, sets, cards)
  const responses = catalogResponses(lang, sets, cards)
  await mapPool(responses, 6, async ([name, data]) => {
    await saveSnapshot(name, data)
    await alive()
  })
  // Celles des séries de la langue qui n'ont plus de cartes : retirées (l'API répond 404). Le
  // préfixe d'une langue ne couvre pas celui de l'autre (`catalog/sets/`, `catalog/fr/sets/`).
  const prefix = snapshotName(lang, 'sets/')
  await removeSnapshots(prefix, new Set(sets.map((set) => `${prefix}${set.id}`)))
  taskJournal('ok', `Catalogue des cartes ${LANGUAGE_NAMES[lang]}`, {
    séries: sets.length,
    cartes: cards.length,
    sansDétail: withoutDetail,
    sansCardmarket: cards.filter((card) => !card.cardmarket).length,
    sansImage: cards.filter((card) => !card.image).length,
  })
  if (skipped) taskJournal('warn', 'Séries écartées (leur id)', { langue: lang, séries: skipped })
  return { refused: null }
}

export async function catalog(step: Step) {
  const refusals: string[] = []
  for (const lang of LANGUAGES) {
    const { refused } = await step(`catalogue ${lang}`, (alive) => saveLanguage(lang, alive))
    if (refused) refusals.push(refused)
  }
  // Levée hors des étapes : dans l'une d'elles, le Workflow la réessaierait, pour rien.
  if (refusals.length) throw new Error(refusals.join(' ; '))
}
