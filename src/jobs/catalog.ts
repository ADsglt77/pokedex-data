/**
 * Tâche `catalog`, à la demande (quand de nouvelles cartes sortent : `bun run ingest cards`) : le
 * catalogue des cartes japonaises, puis des françaises, d'après Pokécardex (avec son accord,
 * `lib/pokecardex.ts`). Ses 450 séries japonaises environ et ses 250 françaises (son plan du
 * site), de 1996 à aujourd'hui, decks et promos ; pour chacune, sa page : son nom, sa date de
 * sortie (au Japon, en France), et toutes ses cartes, dresseurs et énergies compris (numéro, noms
 * français, anglais et allemand, Pokémon, id Cardmarket, rang de son image, rareté, type,
 * illustrateur, versions), les noms des raretés de sa zone et le menu des séries (le bloc de
 * chacune). Aucune sélection ni détection : la rareté et le type servent aux filtres que choisit
 * l'utilisateur. Les ids des cartes et des raretés et les codes des séries se répètent d'une zone
 * à l'autre : chaque langue a ses lignes (`lang`) et ses réponses.
 *
 * Les exclusivités d'autres pays d'Asie (bloc « Asia Exclusive » du menu japonais), rangées avec
 * les japonaises, sont écartées, comme, en français, les cartes qui n'existent qu'en anglais
 * (`only_english`). Le nom de l'extension de chaque série chez Cardmarket (la liste de souhaits) :
 * pour une japonaise, son nom ; pour une française, son nom anglais (le menu d'une page anglaise,
 * lue une fois par passage ; sans elle, ou s'il ne s'accorde pas, celui déjà confirmé) si les
 * adresses Cardmarket de ses cartes le confirment, sinon aucun.
 * Une série est relue après une semaine, après un jour si elle est sortie depuis moins de 90 jours
 * (Pokécardex la complète) ; `--refresh` les relit toutes. Une page par série, une toutes les 3 s :
 * le premier passage prend une vingtaine de minutes pour les japonaises, une douzaine pour les
 * françaises. Une page en échec n'empêche pas les autres ; la tâche échoue ensuite, pour être
 * relancée. Une page soudain vide (le site a changé) ne retire rien. Au début et en fin de tâche,
 * les réponses du catalogue de chaque langue sont recalculées (`snapshots`, `snapshotName`) :
 * `/v1/catalog/species/<n°>` (les cartes d'un Pokémon : la fenêtre d'ajout), `/v1/catalog/sets`
 * (les séries) et `/v1/catalog/sets/<code>` (toutes les cartes d'une série : la page Catalogue,
 * l'image d'une référence) ; en français, `/v1/catalog/fr/…`.
 */

import type { Database } from 'bun:sqlite'
import { TOTAL_SPECIES } from '@/config/pokedex'
import { DAY, HOUR } from '@/lib/time'
import type {
  CardLanguage,
  CatalogFile,
  CatalogRow,
  CatalogSetFile,
  CatalogSetRow,
  CatalogSetsFile,
} from '@/contract'
import { refresh } from '../lib/net'
import {
  asiaExclusive,
  expansionNameOf,
  MAX_FAILURES_IN_A_ROW,
  menuBlocks,
  readEnglishSeriesNames,
  readSeries,
  seriesCodes,
  type PokecardexCard,
  type PokecardexSeries,
} from '../lib/pokecardex'
import { saveSnapshot } from '../snapshots'
import { plural, TerminalProgress } from '../terminal-progress'

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
 * Le nom d'une réponse du catalogue (`rest` : `sets`, `sets/<code>`, `species/<n°>`) : les
 * japonaises gardent leurs noms (`catalog/sets`), les françaises ont les leurs
 * (`catalog/fr/sets`).
 */
export const snapshotName = (lang: CardLanguage, rest: string) =>
  lang === 'ja' ? `catalog/${rest}` : `catalog/fr/${rest}`

/**
 * Enregistre les réponses du catalogue de chaque langue, d'après ses seules lignes ; rien pour une
 * langue tant qu'aucune de ses cartes n'a été lue : un catalogue vide passerait pour disponible
 * (l'API répond 404 en attendant).
 */
export function saveCatalog(db: Database) {
  for (const lang of LANGUAGES) saveLanguage(db, lang)
}

/** Les réponses du catalogue d'une langue. */
function saveLanguage(db: Database, lang: CardLanguage) {
  if (!db.query('SELECT 1 FROM cards WHERE lang = ? LIMIT 1').get(lang)) return
  const sets = (
    db
      .query(
        `SELECT id, name, released, logo, block, block_rank AS blockRank, deck FROM sets
         WHERE lang = ? AND id IN (SELECT set_id FROM cards WHERE lang = ?)`,
      )
      .all(lang, lang) as SetRecord[]
  )
    // Des plus récentes aux plus anciennes ; sorties le même jour, dans l'ordre de leur code.
    .sort((a, b) => b.released.localeCompare(a.released) || a.id.localeCompare(b.id))
  const cards = db
    .query(
      `SELECT set_id AS 'set', number, printed, sort, name, name_en AS en, name_de AS de,
              cardmarket, image, rarity, type, illustrator, versions,
              (SELECT json_group_array(dex_id ORDER BY rank) FROM card_species
               WHERE card_species.lang = cards.lang AND card = cards.id) AS dexIds
       FROM cards WHERE lang = ? ORDER BY sort`,
    )
    .all(lang) as CardRecord[]
  const rarities = new Map(
    (
      db.query('SELECT id, name, rank FROM rarities WHERE lang = ?').all(lang) as RarityRecord[]
    ).map((rarity) => [rarity.id, rarity]),
  )
  const bySet = new Map<string, CardRecord[]>()
  for (const card of cards) {
    const list = bySet.get(card.set)
    if (list) list.push(card)
    else bySet.set(card.set, [card])
  }
  const byId = new Map(sets.map((set) => [set.id, set]))
  const bySpecies = cardsBySpecies(cards, byId)
  const setPrefix = snapshotName(lang, 'sets/')
  // `IMMEDIATE` : chaque réponse est relue (`saveSnapshot`) avant d'être écrite ; une transaction
  // ordinaire échouerait aussitôt si un autre processus écrivait entre les deux (la tâche `prices`,
  // `history`), au lieu d'attendre son tour.
  db.transaction(() => {
    // Chaque Pokémon, même sans carte : la fenêtre d'ajout dit alors qu'il n'en a pas (404 :
    // catalogue pas disponible).
    for (let dexId = 1; dexId <= TOTAL_SPECIES; dexId++) {
      saveSnapshot(
        db,
        snapshotName(lang, `species/${dexId}`),
        speciesResponse(dexId, bySpecies[dexId] ?? [], byId, rarities),
      )
    }
    saveSnapshot(db, snapshotName(lang, 'sets'), setsResponse(sets, bySet))
    for (const set of sets) {
      saveSnapshot(db, `${setPrefix}${set.id}`, setResponse(bySet.get(set.id)!, rarities))
    }
    // Celles des séries de la langue qui n'ont plus de cartes : retirées (l'API répond 404). Le
    // préfixe d'une langue ne couvre pas celui de l'autre (`catalog/sets/`, `catalog/fr/sets/`).
    db.query(
      `DELETE FROM snapshots WHERE name LIKE ? || '%'
       AND name NOT IN (SELECT ? || set_id FROM cards WHERE lang = ?)`,
    ).run(setPrefix, setPrefix, lang)
  }).immediate()
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
    card.number || String(card.sort),
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
        const { name, released, logo } = sets.get(id)!
        return [id, [name, released, logo === 'none' ? 0 : 1]]
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
      set.logo === 'none' ? 0 : 1,
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
      number: card.number || String(card.sort),
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
 * Les séries d'une langue à relire : nouvelles, lues il y a plus d'une semaine, ou d'un jour si
 * récentes.
 */
function dueSeries(db: Database, lang: CardLanguage, codes: string[], now: number) {
  if (refresh) return codes
  const known = new Map(
    (
      db.query('SELECT id, released, read_at AS readAt FROM sets WHERE lang = ?').all(lang) as {
        id: string
        released: string
        readAt: string
      }[]
    ).map((set) => [set.id, set]),
  )
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
 * L'écriture de ce que donnent les pages de Pokécardex, requêtes préparées une fois : une série et
 * ses cartes, les raretés, le bloc de chaque série, chacun dans sa langue (les ids des cartes et
 * des raretés et les codes des séries se répètent d'une zone à l'autre).
 */
export function seriesWriter(db: Database) {
  const writeSet = db.query(
    `INSERT INTO sets (lang, id, name, released, read_at, expansion_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (lang, id) DO UPDATE SET name = excluded.name, released = excluded.released,
                                          read_at = excluded.read_at,
                                          expansion_name = excluded.expansion_name`,
  )
  // Une carte dont la série ou le rang changent a une autre image : à chercher de nouveau.
  const writeCard = db.query(
    `INSERT INTO cards (lang, id, set_id, number, printed, sort, name, name_en, name_de,
                        cardmarket, rarity, type, illustrator, versions, seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (lang, id) DO UPDATE SET
       number = excluded.number, printed = excluded.printed, name = excluded.name,
       name_en = excluded.name_en, name_de = excluded.name_de, cardmarket = excluded.cardmarket,
       rarity = excluded.rarity, type = excluded.type, illustrator = excluded.illustrator,
       versions = excluded.versions, seen = excluded.seen,
       image = CASE WHEN set_id = excluded.set_id AND sort = excluded.sort THEN image END,
       image_checked = CASE WHEN set_id = excluded.set_id AND sort = excluded.sort
                            THEN image_checked END,
       set_id = excluded.set_id, sort = excluded.sort`,
  )
  const writeRarity = db.query(
    `INSERT INTO rarities (lang, id, name, rank) VALUES (?, ?, ?, ?)
     ON CONFLICT (lang, id) DO UPDATE SET name = excluded.name, rank = excluded.rank`,
  )
  const writeBlock = db.query(
    'UPDATE sets SET block = ?, block_rank = ?, deck = ? WHERE lang = ? AND id = ?',
  )
  const clearSpecies = db.query('DELETE FROM card_species WHERE lang = ? AND card = ?')
  const writeSpecies = db.query(
    'INSERT INTO card_species (lang, card, rank, dex_id) VALUES (?, ?, ?, ?)',
  )
  const countCards = db.query('SELECT COUNT(*) AS count FROM cards WHERE lang = ? AND set_id = ?')
  const forget = db.query('DELETE FROM cards WHERE lang = ? AND set_id = ? AND seen != ?')
  const readExpansion = db.query(
    'SELECT expansion_name AS name FROM sets WHERE lang = ? AND id = ?',
  )
  /** Le nombre de cartes de la série déjà en base. */
  const known = (lang: CardLanguage, code: string) =>
    (countCards.get(lang, code) as { count: number }).count
  /** Le nom d'extension Cardmarket de la série déjà en base ; `null` s'il n'y en a pas. */
  const storedExpansion = (lang: CardLanguage, code: string) =>
    (readExpansion.get(lang, code) as { name: string } | null)?.name || null

  /**
   * La page d'une série, enregistrée d'un coup : son nombre de cartes. En français, sans les cartes
   * qui n'existent qu'en anglais ; `englishName` : le nom anglais d'une série française, que les
   * adresses Cardmarket de ses cartes doivent confirmer (`null` : indisponible ce passage). En une
   * transaction `IMMEDIATE` : elle lit la série (ses cartes, son nom d'extension) avant de l'écrire,
   * et attend ainsi son tour si un autre processus écrit (sinon, une série comptée illisible).
   */
  const save = db.transaction(
    (
      lang: CardLanguage,
      code: string,
      page: PokecardexSeries,
      readAt: string,
      englishName: string | null,
    ) => {
      const before = known(lang, code)
      const cartes = lang === 'fr' ? page.cartes.filter((card) => !card.only_english) : page.cartes
      const { fullName, releaseDateFR } = page.currentSeries
      // Le nom de son extension chez Cardmarket (la liste de souhaits) : pour une japonaise, son
      // nom ; pour une française, son nom anglais, s'il s'accorde avec ses cartes. Sans nom anglais
      // ce passage (page anglaise illisible, série absente de son menu), ou avec un nom que ses
      // cartes ne confirment pas (le menu anglais en donne un autre) : celui qu'un passage d'avant
      // a confirmé, tant que ses cartes le confirment encore (sinon aucun).
      const urls = cartes.map((card) => card.cardmarket_url)
      const expansion =
        lang === 'ja'
          ? fullName
          : expansionNameOf(englishName, urls) || expansionNameOf(storedExpansion(lang, code), urls)
      writeSet.run(lang, code, fullName, releaseDateFR?.slice(0, 10) ?? '', readAt, expansion)
      // Le numéro imprimé, sinon le rang. Si deux cartes de la série se confondraient (deux
      // demi-decks numérotés chacun : HS ; cartes géantes de séries diverses : JUMBO), toutes
      // prennent leur rang.
      const keys = cartes.map((card) => numberKey(printedNumber(card.num_card) || `${card.sort}`))
      const distinct = new Set(keys).size === keys.length
      const numberOf = (card: PokecardexCard) => (distinct ? printedNumber(card.num_card) : '')
      for (const card of cartes) {
        const dexIds = (card.id_pokedex_list ?? []).filter(
          (id) => Number.isInteger(id) && id >= 1 && id <= TOTAL_SPECIES,
        )
        const english = stated(card.name_card_en)
        writeCard.run(
          lang,
          card.id_card,
          code,
          numberOf(card),
          stated(card.num_card),
          card.sort,
          stated(card.name_card_fr) || english,
          english,
          stated(card.name_card_de),
          card.id_cardmarket ?? 0,
          card.id_rarete,
          card.id_type,
          stated(card.nom_illustrateur),
          JSON.stringify((card.versions ?? []).map((version) => version.nom_version)),
          readAt,
        )
        clearSpecies.run(lang, card.id_card)
        dexIds.forEach((dexId, rank) => writeSpecies.run(lang, card.id_card, rank, dexId))
      }
      const saved = cartes.length
      // Moins de la moitié des cartes d'avant : le format des pages a changé (un champ renommé),
      // pas l'extension. Rien n'est gardé de cette lecture (la transaction est annulée) : elle
      // compte comme un échec.
      if (saved < before / 2) {
        throw new Error(
          `${code} : ${saved} cartes retenues sur ${before} (format des pages changé ?)`,
        )
      }
      forget.run(lang, code, readAt)
      return saved
    },
  ).immediate

  return {
    known,
    save,
    /** Les raretés d'une langue, que chaque page de sa zone donne toutes. */
    rarities(lang: CardLanguage, page: PokecardexSeries) {
      for (const rarity of page.raretes ?? []) {
        writeRarity.run(lang, rarity.id_rarete, rarity.nom_rarete, rarity.order_rarete)
      }
    },
    /**
     * Le bloc de chaque série d'une langue, d'après son menu : ses séries en boosters, puis ses
     * decks (le menu français n'en a pas : ses decks et kits sont des séries).
     */
    blocks(lang: CardLanguage, menu: PokecardexSeries) {
      for (const [rank, block] of menuBlocks(menu, lang).entries()) {
        for (const series of block.series) {
          writeBlock.run(block.name, rank, 0, lang, series.shortName)
        }
        for (const deck of block.decks ?? []) {
          writeBlock.run(block.name, rank, 1, lang, deck.shortName)
        }
      }
    },
    /** Une série retirée, avec ses cartes. */
    remove(lang: CardLanguage, code: string) {
      db.query('DELETE FROM cards WHERE lang = ? AND set_id = ?').run(lang, code)
      db.query('DELETE FROM sets WHERE lang = ? AND id = ?').run(lang, code)
    },
  }
}

type SeriesWriter = ReturnType<typeof seriesWriter>

/** Ce que ce passage a relu dans une langue, et ce que compte son catalogue en tout. */
function logTotals(db: Database, lang: CardLanguage, read: number, cards: number) {
  const totals = db
    .query(
      `SELECT COUNT(*) AS cards, SUM(cardmarket = 0) AS withoutCardmarket,
              SUM(number != '' AND CAST(number AS INTEGER) != sort) AS otherNumber
       FROM cards WHERE lang = ?`,
    )
    .get(lang) as { cards: number; withoutCardmarket: number | null; otherNumber: number | null }
  console.log(
    `Séries ${LANGUAGE_NAMES[lang]} : ${plural(read, 'relue', 'relues')} ` +
      `(${plural(cards, 'carte', 'cartes')}) ; ` +
      `${totals.cards} cartes en tout, ${totals.withoutCardmarket ?? 0} sans id Cardmarket, ` +
      `${totals.otherNumber ?? 0} dont le numéro imprimé n’est pas le rang de l’image`,
  )
}

/** Les pages anglaises essayées, au plus, pour les noms anglais des séries françaises. */
const ENGLISH_PAGES = 3

/**
 * Les noms anglais des séries françaises (`readEnglishSeriesNames`), d'après la page anglaise de la
 * première à relire, sinon des suivantes (trois au plus) : une page illisible, ou sans ces noms (son
 * menu a changé), ne compte pas. Aucune : aucun nom, la tâche n'échoue pas pour autant ; chaque
 * série française relue garde alors celui que ses cartes confirmaient déjà (`save`).
 */
async function englishNames(due: string[]) {
  for (const code of due.slice(0, ENGLISH_PAGES)) {
    try {
      const names = await readEnglishSeriesNames(code)
      if (names.size) {
        console.log(
          `Pokécardex : noms anglais de ${plural(names.size, 'série', 'séries')} (page de ${code})`,
        )
        return names
      }
      console.warn(`  ${code} : page anglaise sans les noms des séries françaises`)
    } catch (error) {
      console.warn(
        `  ${code} : page anglaise illisible :`,
        error instanceof Error ? error.message : error,
      )
    }
  }
  console.warn(
    '  Noms anglais des séries indisponibles : les séries françaises relues gardent leur nom ' +
      'd’extension Cardmarket déjà confirmé',
  )
  return new Map<string, string>()
}

/** Ce qu'a donné la lecture des séries d'une langue. */
interface LanguagePass {
  /** Les séries illisibles. */
  failed: string[]
  /** Les séries qui avaient déjà des cartes, relues, et celles d'entre elles rendues sans cartes. */
  knownRead: number
  knownEmpty: number
  /** Trop de pages en échec d'affilée : la lecture s'est arrêtée là. */
  interrupted: boolean
}

/** Lit les séries à relire d'une langue (`due`), et les enregistre. */
async function readLanguage(
  db: Database,
  writer: SeriesWriter,
  lang: CardLanguage,
  due: string[],
): Promise<LanguagePass> {
  const pass: LanguagePass = { failed: [], knownRead: 0, knownEmpty: 0, interrupted: false }
  // Le nom anglais de chaque série française : une page anglaise, d'une des premières à relire.
  const english = lang === 'fr' && due.length ? await englishNames(due) : new Map<string, string>()
  let inARow = 0
  let cards = 0
  let read = 0
  // Les exclusivités d'autres pays d'Asie (au Japon) et les blocs, d'après le menu de la première
  // page lue, et les raretés de la langue, que chaque page donne toutes.
  let asian = new Set<string>()
  let menu: PokecardexSeries | null = null
  const progress = new TerminalProgress(`Séries ${LANGUAGE_NAMES[lang]}`, due.length)
  for (const [index, code] of due.entries()) {
    if (asian.has(code)) {
      progress.update(index + 1)
      continue
    }
    try {
      const page = await readSeries(lang, code)
      if (!menu) {
        menu = page
        if (lang === 'ja') asian = asiaExclusive(page)
        writer.rarities(lang, page)
      }
      if (asian.has(code)) continue
      const known = writer.known(lang, code)
      if (known) pass.knownRead++
      // Une page sans cartes : une série annoncée mais pas encore remplie, ou le site a changé (on
      // garde alors celles d'avant). Rien n'est noté : elle est relue au passage suivant.
      if (!page.cartes?.length) {
        if (known) {
          pass.knownEmpty++
          progress.clear()
          console.warn(`  ${code} : page sans cartes, celles d’avant restent (${known})`)
          progress.redraw()
        }
        continue
      }
      cards += writer.save(lang, code, page, new Date().toISOString(), english.get(code) ?? null)
      read++
      inARow = 0
    } catch (error) {
      pass.failed.push(code)
      progress.clear()
      console.warn(`  ${code} :`, error instanceof Error ? error.message : error)
      if (++inARow >= MAX_FAILURES_IN_A_ROW) {
        console.warn(`  ${inARow} séries en échec d’affilée : la lecture s’arrête là.`)
        pass.interrupted = true
        break
      }
      progress.redraw()
    } finally {
      progress.update(index + 1)
    }
  }
  if (pass.interrupted) progress.stop()
  else progress.finish()
  // Celles qu'un passage d'avant aurait gardées : retirées.
  for (const code of asian) writer.remove(lang, code)
  // Le bloc de chaque série, les nouvelles comprises (enregistrées depuis).
  if (menu) writer.blocks(lang, menu)
  logTotals(db, lang, read, cards)
  return pass
}

export async function catalog(db: Database) {
  // La réponse d'après les tables, tout de suite : une forme changée avec le code (ou retirée par
  // une étape du schéma) est refaite sans attendre la lecture des séries (une demi-heure quand
  // toutes sont à relire).
  saveCatalog(db)
  // Les séries à relire de chaque langue, avant toute lecture : un plan du site illisible arrête
  // la tâche avant qu'elle n'ait rien lu (et non après les japonaises, sans leurs réponses).
  const due: [CardLanguage, string[]][] = []
  for (const lang of LANGUAGES) {
    const codes = await seriesCodes(lang)
    const toRead = dueSeries(db, lang, codes, Date.now())
    console.log(
      `Pokécardex : ${codes.length} séries ${LANGUAGE_NAMES[lang]}, ${toRead.length} à relire`,
    )
    due.push([lang, toRead])
  }

  const writer = seriesWriter(db)
  const failed: string[] = []
  let knownRead = 0
  let knownEmpty = 0
  for (const [lang, codes] of due) {
    const pass = await readLanguage(db, writer, lang, codes)
    failed.push(...pass.failed)
    knownRead += pass.knownRead
    knownEmpty += pass.knownEmpty
    // Le site a sans doute changé : l'autre langue n'est pas lue non plus.
    if (pass.interrupted) break
  }

  saveCatalog(db)
  if (failed.length) {
    throw new Error(
      `${plural(failed.length, 'série illisible', 'séries illisibles')} (${failed.slice(0, 10).join(', ')})`,
    )
  }
  // Plus de la moitié des séries déjà connues rendues sans cartes : le format des pages a changé
  // (le champ des cartes renommé), pas les séries. Leurs cartes d'avant restent ; la tâche échoue,
  // pour que la page Données et la surveillance le disent (sinon, un catalogue figé sans un mot).
  if (knownEmpty > 0 && knownEmpty * 2 > knownRead) {
    throw new Error(
      `Séries déjà connues rendues sans cartes : ${knownEmpty} sur ${knownRead} (format des pages changé ?)`,
    )
  }
}
