/**
 * Tâche `catalog`, à la demande (quand de nouvelles cartes sortent : `bun run ingest cards`) : le
 * catalogue des cartes japonaises, puis des françaises, d'après Pokécardex (avec son accord,
 * `pokecardex.ts`). Ses 450 séries japonaises environ et ses 250 françaises (son plan du site), de
 * 1996 à aujourd'hui, decks et promos ; pour chacune, sa page : son nom, sa date de sortie (au
 * Japon, en France), et toutes ses cartes, dresseurs et énergies compris (numéro, noms français,
 * anglais et allemand, Pokémon, id Cardmarket, rang de son image, rareté, type, illustrateur,
 * versions), les noms des raretés de sa zone et le menu des séries (le bloc de chacune). Aucune
 * sélection ni détection : la rareté et le type servent aux filtres que choisit l'utilisateur. Les
 * ids des cartes et des raretés et les codes des séries se répètent d'une zone à l'autre : chaque
 * langue a ses lignes (`lang`) et ses réponses.
 *
 * Les exclusivités d'autres pays d'Asie (bloc « Asia Exclusive » du menu japonais), rangées avec
 * les japonaises, sont écartées, comme, en français, les cartes qui n'existent qu'en anglais
 * (`only_english`). Le nom de l'extension de chaque série chez Cardmarket (la liste de souhaits) :
 * pour une japonaise, son nom ; pour une française, son nom anglais (le menu d'une page anglaise,
 * lue une fois par passage ; sans elle, ou s'il ne s'accorde pas, celui déjà confirmé) si les
 * adresses Cardmarket de ses cartes le confirment, sinon aucun.
 * Une série est relue après une semaine, après un jour si elle est sortie depuis moins de 90 jours
 * (Pokécardex la complète) ; `refresh` les relit toutes. Une étape du Workflow par série, une page
 * toutes les 3 s : le premier passage prend une vingtaine de minutes pour les japonaises, une
 * douzaine pour les françaises. Une page en échec n'empêche pas les autres ; la tâche échoue
 * ensuite, pour être relancée. Une page soudain vide (le site a changé) ne retire rien. Une série
 * renumérotée par la source (les cartes déjà copiées qui changent de série ou de rang) : le journal
 * compte ces cartes, en fin de langue (docs/donnees.md, « Une série renumérotée »). En fin de tâche,
 * les réponses du catalogue de chaque langue sont recalculées, dans R2 (`saveCatalog`) :
 * `/v1/catalog/species/<n°>` (les cartes d'un Pokémon : la fenêtre d'ajout), `/v1/catalog/sets`
 * (les séries) et `/v1/catalog/sets/<code>` (toutes les cartes d'une série : la page Catalogue,
 * l'image d'une référence) ; en français, `/v1/catalog/fr/…`.
 */

import { env } from 'cloudflare:workers'
import { snapshotName } from '@/config/catalog'
import { SPECIES_IDS, TOTAL_SPECIES } from '@/config/pokedex'
import type {
  CardLanguage,
  CatalogFile,
  CatalogRow,
  CatalogSetFile,
  CatalogSetRow,
  CatalogSetsFile,
} from '@/contract'
import { DAY, HOUR } from '@/lib/time'
import { journal, plural, reasonOf } from '../journal'
import { removeSnapshots, saveSnapshot } from '../snapshots'
import { mapPool } from './net'
import {
  asiaExclusive,
  expansionNameOf,
  MAX_FAILURES_IN_A_ROW,
  menuBlocks,
  readEnglishSeriesNames,
  readSeries,
  readSitemap,
  seriesIn,
  type PokecardexCard,
  type PokecardexSeries,
} from './pokecardex'
import type { Step } from './workflow'

/**
 * Un numéro comparable : `017` et `17` sont la même carte, `tg01` et `TG01` aussi (la même règle
 * que la référence d'une carte dans le site).
 */
const numberKey = (number: string) =>
  /^\d+$/.test(number) ? String(Number(number)) : number.toUpperCase()

/** Un texte de Pokécardex ; '' pour un tiret seul, qu'il écrit pour « inconnu » (« — »). */
const stated = (text: string | null) => (/^[\s—–-]*$/.test(text ?? '') ? '' : text!.trim())

/** Le numéro imprimé : « 001/165 » → 001, « TG01/TG30 » → TG01 ; « — », « SV-P » : aucun. */
function printedNumber(text: string) {
  const number = text.split('/')[0]!.trim()
  return /\d/.test(number) ? number : ''
}

/** Une série, telle que la gardent les tables. */
interface SetRecord {
  id: string
  name: string
  released: string
  logo: 'pokecardex' | 'none' | null
  block: string | null
  blockRank: number | null
  deck: 0 | 1
}

/** Une carte, telle que la gardent les tables, avec ses Pokémon (JSON). */
interface CardRecord {
  set: string
  number: string
  printed: string
  sort: number
  name: string
  en: string
  de: string
  cardmarket: number
  image: 'pokecardex' | 'none' | null
  rarity: number | null
  type: number | null
  illustrator: string
  versions: string
  dexIds: string
}

interface RarityRecord {
  id: number
  name: string
  rank: number
}

/** Les langues du catalogue, dans l'ordre de leur lecture. */
const LANGUAGES: CardLanguage[] = ['ja', 'fr']

/** Les séries d'une langue, dans le journal : « séries japonaises ». */
const LANGUAGE_NAMES: Record<CardLanguage, string> = { ja: 'japonaises', fr: 'françaises' }

/**
 * Enregistre les réponses du catalogue de chaque langue, une étape chacune, d'après ses seules
 * lignes ; rien pour une langue tant qu'aucune de ses cartes n'a été lue : un catalogue vide
 * passerait pour disponible (l'API répond 404 en attendant).
 */
export async function saveCatalog(step: Step) {
  for (const lang of LANGUAGES) {
    await step(`réponses du catalogue ${lang}`, () => saveLanguage(lang))
  }
}

/** Les réponses du catalogue d'une langue, écrites quelques-unes à la fois. */
export async function saveLanguage(lang: CardLanguage) {
  const [setRows, cardRows, rarityRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, name, released, logo, block, block_rank AS blockRank, deck FROM sets
       WHERE lang = ? AND id IN (SELECT set_id FROM cards WHERE lang = ?)`,
    ).bind(lang, lang),
    env.DB.prepare(
      `SELECT set_id AS 'set', number, printed, sort, name, name_en AS en, name_de AS de,
              cardmarket, image, rarity, type, illustrator, versions,
              (SELECT json_group_array(dex_id ORDER BY rank) FROM card_species
               WHERE card_species.lang = cards.lang AND card = cards.id) AS dexIds
       FROM cards WHERE lang = ? ORDER BY sort`,
    ).bind(lang),
    env.DB.prepare('SELECT id, name, rank FROM rarities WHERE lang = ?').bind(lang),
  ])
  const cards = cardRows!.results as CardRecord[]
  if (!cards.length) return
  const sets = (setRows!.results as SetRecord[])
    // Des plus récentes aux plus anciennes ; sorties le même jour, dans l'ordre de leur code.
    .sort((a, b) => b.released.localeCompare(a.released) || a.id.localeCompare(b.id))
  const rarities = new Map(
    (rarityRows!.results as RarityRecord[]).map((rarity) => [rarity.id, rarity]),
  )
  const bySet = Map.groupBy(cards, (card) => card.set)
  const byId = new Map(sets.map((set) => [set.id, set]))
  const bySpecies = cardsBySpecies(cards, byId)
  const setPrefix = snapshotName(lang, 'sets/')
  const responses: [name: string, data: unknown][] = [
    // Chaque Pokémon, même sans carte : la fenêtre d'ajout dit alors qu'il n'en a pas (404 :
    // catalogue pas disponible).
    ...SPECIES_IDS.map((id): [string, unknown] => [
      snapshotName(lang, `species/${id}`),
      speciesResponse(id, bySpecies[id] ?? [], byId, rarities),
    ]),
    [snapshotName(lang, 'sets'), setsResponse(sets, bySet)],
    ...sets.map((set): [string, unknown] => [
      `${setPrefix}${set.id}`,
      setResponse(bySet.get(set.id)!, rarities),
    ]),
  ]
  await mapPool(responses, 6, ([name, data]) => saveSnapshot(name, data))
  // Celles des séries de la langue qui n'ont plus de cartes : retirées (l'API répond 404). Le
  // préfixe d'une langue ne couvre pas celui de l'autre (`catalog/sets/`, `catalog/fr/sets/`).
  await removeSnapshots(setPrefix, new Set(sets.map((set) => `${setPrefix}${set.id}`)))
}

/** Les raretés de ces cartes : `[nom, rang]` par numéro. */
const raritiesOf = (cards: CardRecord[], rarities: Map<number, RarityRecord>) =>
  Object.fromEntries(
    [...new Set(cards.map((card) => card.rarity))]
      .map((id) => id !== null && rarities.get(id))
      .filter((rarity) => !!rarity)
      .map(({ id, name, rank }) => [id, [name, rank]]),
  ) as CatalogFile['rarities']

/**
 * Le numéro de l'image chez Pokécardex : son rang ; 0 s'il n'en a pas. Une image pas encore
 * cherchée : celle de Pokécardex, qui les a presque toutes (la tâche `images` la copie ; d'ici là,
 * l'API répond 404 et le site montre la carte de substitution).
 */
const imageOf = (card: CardRecord) => (card.image === 'none' ? 0 : card.sort)

/** Le numéro d'une carte dans les réponses : l'imprimé (`saveSeries`), sinon son rang. */
const shownNumber = (card: CardRecord) => card.number || String(card.sort)

/** Le logo d'une série dans les réponses : 0 si la source n'en a pas, sinon 1. */
const logoOf = (set: SetRecord) => (set.logo === 'none' ? 0 : 1)

/**
 * Les cartes Pokémon de chaque Pokémon, des plus récentes aux plus anciennes ; dans une série, de
 * la dernière carte à la première.
 */
function cardsBySpecies(cards: CardRecord[], sets: Map<string, SetRecord>) {
  const released = (card: CardRecord) => sets.get(card.set)!.released
  const sorted = cards.toSorted(
    (a, b) =>
      released(b).localeCompare(released(a)) || a.set.localeCompare(b.set) || b.sort - a.sort,
  )
  const bySpecies: Record<number, CardRecord[]> = {}
  for (const card of sorted) {
    for (const dexId of JSON.parse(card.dexIds) as number[]) (bySpecies[dexId] ??= []).push(card)
  }
  return bySpecies
}

/** Une carte Pokémon, telle que la donne `/v1/catalog/species/<n°>`. */
function catalogRow(card: CardRecord): CatalogRow {
  const dexIds = JSON.parse(card.dexIds) as number[]
  const row: CatalogRow = [
    card.set,
    shownNumber(card),
    card.cardmarket,
    card.name,
    imageOf(card),
    card.rarity ?? 0,
    card.type ?? 0,
  ]
  if (dexIds.length > 1) row.push(dexIds)
  return row
}

/**
 * `/v1/catalog/species/<n°>` : les cartes d'un Pokémon (`cardsBySpecies` : la fenêtre d'ajout d'une
 * carte), avec leurs seules séries, dans l'ordre de ses cartes, et leurs raretés.
 */
function speciesResponse(
  dexId: number,
  cards: CardRecord[],
  sets: Map<string, SetRecord>,
  rarities: Map<number, RarityRecord>,
): CatalogFile {
  return {
    sets: Object.fromEntries(
      [...new Set(cards.map((card) => card.set))].map((id) => {
        const set = sets.get(id)!
        return [id, [set.name, set.released, logoOf(set)]]
      }),
    ),
    cards: cards.length ? { [dexId]: cards.map(catalogRow) } : {},
    rarities: raritiesOf(cards, rarities),
  }
}

/** `/v1/catalog/sets` : les séries, leur bloc et leur nombre de cartes (la page Catalogue). */
function setsResponse(sets: SetRecord[], bySet: Map<string, CardRecord[]>): CatalogSetsFile {
  // Les blocs dans l'ordre du menu ; chaque série renvoie au sien par son rang dans la liste.
  const blocks = [
    ...new Set(
      sets
        .filter((set) => set.block !== null)
        .sort((a, b) => a.blockRank! - b.blockRank!)
        .map((set) => set.block!),
    ),
  ]
  return {
    blocks,
    sets: sets.map((set) => [
      set.id,
      set.name,
      set.released,
      logoOf(set),
      bySet.get(set.id)!.length,
      set.block === null ? -1 : blocks.indexOf(set.block),
      set.deck,
    ]),
  }
}

/** `/v1/catalog/sets/<code>` : toutes les cartes d'une série, dans son ordre. */
function setResponse(cards: CardRecord[], rarities: Map<number, RarityRecord>): CatalogSetFile {
  return {
    cards: cards.map((card): CatalogSetRow => ({
      number: shownNumber(card),
      printed: card.printed,
      name: card.name,
      en: card.en,
      de: card.de,
      dexIds: JSON.parse(card.dexIds) as number[],
      cardmarket: card.cardmarket,
      image: imageOf(card),
      rarity: card.rarity ?? 0,
      type: card.type ?? 0,
      illustrator: card.illustrator,
      versions: JSON.parse(card.versions) as string[],
    })),
    rarities: raritiesOf(cards, rarities),
  }
}

/**
 * Les séries d'une langue à relire (`codes` : celles du plan du site) : nouvelles, lues il y a plus
 * d'une semaine, ou d'un jour si récentes ; toutes avec `refresh`.
 */
async function dueSeries(lang: CardLanguage, codes: string[], now: number, refresh: boolean) {
  if (refresh) return codes
  const { results } = await env.DB.prepare(
    'SELECT id, released, read_at AS readAt FROM sets WHERE lang = ?',
  )
    .bind(lang)
    .all<{ id: string; released: string; readAt: string }>()
  const known = new Map(results.map((set) => [set.id, set]))
  return codes.filter((code) => {
    const set = known.get(code)
    if (!set) return true
    const recent = !set.released || now - Date.parse(set.released) < 90 * DAY
    // Un peu moins qu'un jour et qu'une semaine : relancée à la même heure (à la main, la tâche
    // n'a pas de rythme), elle relit bien ce qui a un jour ou une semaine.
    return now - Date.parse(set.readAt) > (recent ? 20 * HOUR : 6 * DAY + 20 * HOUR)
  })
}

/**
 * La page d'une série, enregistrée d'un seul tenant (`batch`) : son nombre de cartes, et celui de
 * ses cartes déjà copiées (`image` noté) que la source a changées de série ou de rang
 * (docs/donnees.md, « Une série renumérotée »). En français, sans les cartes qui n'existent qu'en
 * anglais ; `englishName` : le nom anglais d'une série française, que les adresses Cardmarket de
 * ses cartes doivent confirmer (`null` : indisponible ce passage). Une carte dont la série ou le
 * rang changent a une autre image : à chercher de nouveau.
 */
export async function saveSeries(
  lang: CardLanguage,
  code: string,
  page: PokecardexSeries,
  readAt: string,
  englishName: string | null,
) {
  const cartes = lang === 'fr' ? page.cartes.filter((card) => !card.only_english) : page.cartes
  const { fullName, releaseDateFR } = page.currentSeries
  const placed = JSON.stringify(cartes.map(({ id_card, sort }) => ({ id: id_card, sort })))
  const [count, stored, renumbered] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS count FROM cards WHERE lang = ? AND set_id = ?').bind(
      lang,
      code,
    ),
    env.DB.prepare('SELECT expansion_name AS name FROM sets WHERE lang = ? AND id = ?').bind(
      lang,
      code,
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM cards JOIN json_each(?) AS page
       ON cards.id = json_extract(page.value, '$.id')
       WHERE cards.lang = ? AND cards.image = 'pokecardex'
         AND (cards.set_id != ? OR cards.sort != json_extract(page.value, '$.sort'))`,
    ).bind(placed, lang, code),
  ])
  const before = (count!.results[0] as { count: number }).count
  // Moins de la moitié des cartes d'avant : le format des pages a changé (un champ renommé), pas
  // l'extension. Rien n'est gardé de cette lecture : elle compte comme un échec.
  if (cartes.length < before / 2) {
    throw new Error(
      `${code} : ${cartes.length} cartes retenues sur ${before} (format des pages changé ?)`,
    )
  }
  // Le nom de son extension chez Cardmarket (la liste de souhaits) : pour une japonaise, son nom ;
  // pour une française, son nom anglais, s'il s'accorde avec ses cartes. Sans nom anglais ce
  // passage (page anglaise illisible, série absente de son menu), ou avec un nom que ses cartes ne
  // confirment pas (le menu anglais en donne un autre) : celui qu'un passage d'avant a confirmé,
  // tant que ses cartes le confirment encore (sinon aucun).
  const urls = cartes.map((card) => card.cardmarket_url)
  const storedName = (stored!.results[0] as { name: string } | undefined)?.name || null
  const expansion =
    lang === 'ja'
      ? fullName
      : expansionNameOf(englishName, urls) || expansionNameOf(storedName, urls)
  // Le numéro imprimé, sinon le rang. Si deux cartes de la série se confondraient (deux
  // demi-decks numérotés chacun : HS ; cartes géantes de séries diverses : JUMBO), toutes
  // prennent leur rang.
  const keys = cartes.map((card) => numberKey(printedNumber(card.num_card) || `${card.sort}`))
  const distinct = new Set(keys).size === keys.length
  const numberOf = (card: PokecardexCard) => (distinct ? printedNumber(card.num_card) : '')
  const rows = cartes.map((card) => {
    const english = stated(card.name_card_en)
    return {
      id: card.id_card,
      number: numberOf(card),
      printed: stated(card.num_card),
      sort: card.sort,
      name: stated(card.name_card_fr) || english,
      en: english,
      de: stated(card.name_card_de),
      cardmarket: card.id_cardmarket ?? 0,
      rarity: card.id_rarete,
      type: card.id_type,
      illustrator: stated(card.nom_illustrateur),
      versions: JSON.stringify((card.versions ?? []).map((version) => version.nom_version)),
      dexIds: (card.id_pokedex_list ?? []).filter(
        (id) => Number.isInteger(id) && id >= 1 && id <= TOTAL_SPECIES,
      ),
    }
  })
  const json = JSON.stringify(rows)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sets (lang, id, name, released, read_at, expansion_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (lang, id) DO UPDATE SET name = excluded.name, released = excluded.released,
                                            read_at = excluded.read_at,
                                            expansion_name = excluded.expansion_name`,
    ).bind(lang, code, fullName, releaseDateFR?.slice(0, 10) ?? '', readAt, expansion),
    env.DB.prepare(
      `INSERT INTO cards (lang, id, set_id, number, printed, sort, name, name_en, name_de,
                          cardmarket, rarity, type, illustrator, versions, seen)
       SELECT ?2, json_extract(value, '$.id'), ?3, json_extract(value, '$.number'),
              json_extract(value, '$.printed'), json_extract(value, '$.sort'),
              json_extract(value, '$.name'), json_extract(value, '$.en'),
              json_extract(value, '$.de'), json_extract(value, '$.cardmarket'),
              json_extract(value, '$.rarity'), json_extract(value, '$.type'),
              json_extract(value, '$.illustrator'), json_extract(value, '$.versions'), ?4
       FROM json_each(?1) WHERE true
       ON CONFLICT (lang, id) DO UPDATE SET
         number = excluded.number, printed = excluded.printed, name = excluded.name,
         name_en = excluded.name_en, name_de = excluded.name_de, cardmarket = excluded.cardmarket,
         rarity = excluded.rarity, type = excluded.type, illustrator = excluded.illustrator,
         versions = excluded.versions, seen = excluded.seen,
         image = CASE WHEN set_id = excluded.set_id AND sort = excluded.sort THEN image END,
         image_checked = CASE WHEN set_id = excluded.set_id AND sort = excluded.sort
                              THEN image_checked END,
         set_id = excluded.set_id, sort = excluded.sort`,
    ).bind(json, lang, code, readAt),
    env.DB.prepare(
      `DELETE FROM card_species WHERE lang = ?2
       AND card IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`,
    ).bind(json, lang),
    env.DB.prepare(
      `INSERT INTO card_species (lang, card, rank, dex_id)
       SELECT ?2, json_extract(card.value, '$.id'), dex.key, dex.value
       FROM json_each(?1) AS card, json_each(card.value, '$.dexIds') AS dex`,
    ).bind(json, lang),
    env.DB.prepare('DELETE FROM cards WHERE lang = ? AND set_id = ? AND seen != ?').bind(
      lang,
      code,
      readAt,
    ),
  ])
  return { saved: cartes.length, moved: (renumbered!.results[0] as { count: number }).count }
}

/** Les raretés d'une langue, que chaque page de sa zone donne toutes. */
async function saveRarities(lang: CardLanguage, page: PokecardexSeries) {
  const raretes = page.raretes ?? []
  if (!raretes.length) return
  await env.DB.prepare(
    `INSERT INTO rarities (lang, id, name, rank)
     SELECT ?2, json_extract(value, '$.id_rarete'), json_extract(value, '$.nom_rarete'),
            json_extract(value, '$.order_rarete')
     FROM json_each(?1) WHERE true
     ON CONFLICT (lang, id) DO UPDATE SET name = excluded.name, rank = excluded.rank`,
  )
    .bind(JSON.stringify(raretes), lang)
    .run()
}

/** Un bloc du menu des séries : son nom, ses séries en boosters, puis ses decks. */
interface MenuBlock {
  name: string
  series: string[]
  decks: string[]
}

/** Les blocs du menu d'une page, ce qu'en garde la tâche. */
const blocksOf = (page: PokecardexSeries, lang: CardLanguage): MenuBlock[] =>
  menuBlocks(page, lang).map((block) => ({
    name: block.name,
    series: block.series.map((series) => series.shortName),
    decks: (block.decks ?? []).map((deck) => deck.shortName),
  }))

/**
 * Le bloc de chaque série d'une langue, d'après son menu : ses séries en boosters, puis ses decks
 * (le menu français n'en a pas : ses decks et kits sont des séries) ; et les séries retirées
 * (`removed` : les exclusivités d'autres pays d'Asie qu'un passage d'avant aurait gardées).
 */
export async function saveBlocks(lang: CardLanguage, blocks: MenuBlock[], removed: string[]) {
  const block = env.DB.prepare(
    'UPDATE sets SET block = ?, block_rank = ?, deck = ? WHERE lang = ? AND id = ?',
  )
  const gone = JSON.stringify(removed)
  await env.DB.batch([
    ...blocks.flatMap(({ name, series, decks }, rank) => [
      ...series.map((code) => block.bind(name, rank, 0, lang, code)),
      ...decks.map((code) => block.bind(name, rank, 1, lang, code)),
    ]),
    env.DB.prepare(
      'DELETE FROM cards WHERE lang = ? AND set_id IN (SELECT value FROM json_each(?))',
    ).bind(lang, gone),
    env.DB.prepare(
      'DELETE FROM sets WHERE lang = ? AND id IN (SELECT value FROM json_each(?))',
    ).bind(lang, gone),
  ])
}

/**
 * Ce que ce passage a relu dans une langue, et ce que compte son catalogue en tout ; et les cartes
 * déjà copiées qu'il a vues changer de série ou de rang : le fichier du rang d'une carte est alors
 * celui d'une autre, et la collection d'un compte qui garde l'ancien chemin montre ce scan-là. Le
 * nombre seulement : rien d'autre ne change.
 */
async function logTotals(lang: CardLanguage, read: number, cards: number, renumbered: number) {
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS cards, SUM(cardmarket = 0) AS withoutCardmarket,
            SUM(number != '' AND CAST(number AS INTEGER) != sort) AS otherNumber
     FROM cards WHERE lang = ?`,
  )
    .bind(lang)
    .first<{ cards: number; withoutCardmarket: number | null; otherNumber: number | null }>()
  journal({
    topic: 'tâches',
    level: 'ok',
    message: `Séries ${LANGUAGE_NAMES[lang]} relues`,
    details: {
      séries: read,
      cartes: cards,
      catalogue: totals!.cards,
      sansCardmarket: totals!.withoutCardmarket ?? 0,
      autreNuméro: totals!.otherNumber ?? 0,
    },
  })
  if (renumbered) {
    journal({
      topic: 'tâches',
      level: 'warn',
      message: 'Série renumérotée par la source',
      details: { langue: lang, cartesCopiées: renumbered },
    })
  }
}

/** Les pages anglaises essayées, au plus, pour les noms anglais des séries françaises. */
const ENGLISH_PAGES = 3

/**
 * Les noms anglais des séries françaises (`readEnglishSeriesNames`), d'après la page anglaise de la
 * première à relire, sinon des suivantes (trois au plus) : une page illisible, ou sans ces noms (son
 * menu a changé), ne compte pas. Aucune : aucun nom, la tâche n'échoue pas pour autant ; chaque
 * série française relue garde alors celui que ses cartes confirmaient déjà (`saveSeries`).
 */
async function englishNames(due: string[]): Promise<[string, string][]> {
  for (const code of due.slice(0, ENGLISH_PAGES)) {
    try {
      const names = await readEnglishSeriesNames(code)
      if (names.size) return [...names]
    } catch (error) {
      journal({
        topic: 'tâches',
        level: 'warn',
        message: 'Page anglaise illisible',
        details: { série: code, raison: reasonOf(error) },
      })
    }
  }
  journal({ topic: 'tâches', level: 'warn', message: 'Noms anglais des séries indisponibles' })
  return []
}

/** Ce qu'a donné la lecture d'une série. */
type SeriesOutcome =
  | { status: 'saved'; saved: number; moved: number; known: number }
  | { status: 'empty'; known: number }
  | { status: 'skipped' }
  | { status: 'failed'; reason: string }

/** Ce que la première page lue d'une langue apprend : ses blocs et, au Japon, les séries d'Asie. */
interface Menu {
  blocks: MenuBlock[]
  asian: string[]
}

/**
 * Lit et enregistre une série ; la première page lue d'une langue (`firstPage`) donne aussi les
 * raretés de la langue, ses blocs et ses exclusivités d'Asie.
 */
async function readOne(
  lang: CardLanguage,
  code: string,
  englishName: string | null,
  firstPage: boolean,
): Promise<{ outcome: SeriesOutcome; menu: Menu | null }> {
  try {
    const page = await readSeries(lang, code)
    const menu = firstPage
      ? { blocks: blocksOf(page, lang), asian: lang === 'ja' ? [...asiaExclusive(page)] : [] }
      : null
    if (menu) {
      await saveRarities(lang, page)
      if (menu.asian.includes(code)) return { outcome: { status: 'skipped' }, menu }
    }
    const known = (await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM cards WHERE lang = ? AND set_id = ?',
    )
      .bind(lang, code)
      .first<{ count: number }>())!.count
    // Une page sans cartes : une série annoncée mais pas encore remplie, ou le site a changé (on
    // garde alors celles d'avant). Rien n'est noté : elle est relue au passage suivant.
    if (!page.cartes?.length) return { outcome: { status: 'empty', known }, menu }
    const saved = await saveSeries(lang, code, page, new Date().toISOString(), englishName)
    return { outcome: { status: 'saved', ...saved, known }, menu }
  } catch (error) {
    return { outcome: { status: 'failed', reason: reasonOf(error) }, menu: null }
  }
}

export async function catalog(step: Step, refresh: boolean) {
  // Les séries à relire de chaque langue, avant toute lecture : un plan du site illisible arrête la
  // tâche avant qu'elle n'ait rien lu (et non après les japonaises, sans leurs réponses).
  const due = await step('séries à relire', async () => {
    const now = Date.now()
    const due: [CardLanguage, string[]][] = []
    const sitemap = await readSitemap()
    for (const lang of LANGUAGES) {
      const codes = seriesIn(sitemap, lang)
      const toRead = await dueSeries(lang, codes, now, refresh)
      due.push([lang, toRead])
      journal({
        topic: 'tâches',
        level: 'info',
        message: `Séries ${LANGUAGE_NAMES[lang]} à relire`,
        details: { relues: toRead.length, sur: codes.length },
      })
    }
    return due
  })

  const failed: string[] = []
  let knownRead = 0
  let knownEmpty = 0
  for (const [lang, codes] of due) {
    // Le nom anglais de chaque série française : une page anglaise, d'une des premières à relire.
    const english = new Map(
      lang === 'fr' && codes.length ? await step('noms anglais', () => englishNames(codes)) : [],
    )
    let menu: Menu | null = null
    let inARow = 0
    let read = 0
    let cards = 0
    let renumbered = 0
    for (const code of codes) {
      if (menu?.asian.includes(code)) continue
      const firstPage: boolean = menu === null
      const result: { outcome: SeriesOutcome; menu: Menu | null } = await step(
        `${lang} ${code}`,
        () => readOne(lang, code, english.get(code) ?? null, firstPage),
      )
      menu ??= result.menu
      const { outcome } = result
      if (outcome.status === 'failed') {
        failed.push(code)
        journal({
          topic: 'tâches',
          level: 'warn',
          message: 'Série illisible',
          details: { langue: lang, série: code, raison: outcome.reason },
        })
        if (++inARow >= MAX_FAILURES_IN_A_ROW) break
        continue
      }
      inARow = 0
      if (outcome.status === 'skipped') continue
      if (outcome.known) knownRead++
      if (outcome.status === 'empty') {
        if (outcome.known) knownEmpty++
        continue
      }
      read++
      cards += outcome.saved
      renumbered += outcome.moved
    }
    // Les blocs de chaque série, les nouvelles comprises ; les séries d'Asie retirées.
    if (menu) {
      const { blocks, asian } = menu
      await step(`blocs ${lang}`, () => saveBlocks(lang, blocks, asian))
    }
    await step(`bilan ${lang}`, () => logTotals(lang, read, cards, renumbered))
    // Le site a sans doute changé : l'autre langue n'est pas lue non plus.
    if (inARow >= MAX_FAILURES_IN_A_ROW) break
  }

  await saveCatalog(step)
  if (failed.length) {
    const some = failed.slice(0, 10).join(', ')
    throw new Error(`${plural(failed.length, 'série illisible', 'séries illisibles')} (${some})`)
  }
  // Plus de la moitié des séries déjà connues rendues sans cartes : le format des pages a changé
  // (le champ des cartes renommé), pas les séries. Leurs cartes d'avant restent ; la tâche échoue,
  // pour que la page Réglages et la surveillance le disent (sinon, un catalogue figé sans un mot).
  if (knownEmpty > 0 && knownEmpty * 2 > knownRead) {
    throw new Error(
      `Séries déjà connues rendues sans cartes : ${knownEmpty} sur ${knownRead} (format des pages changé ?)`,
    )
  }
}
