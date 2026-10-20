/**
 * Tâche `catalog`, à la demande (quand de nouvelles cartes sortent : `bun run ingest cards`) : le
 * catalogue des cartes japonaises, d'après Pokécardex (avec son accord, `lib/pokecardex.ts`). Ses
 * 450 séries japonaises environ (son plan du site), de 1996 à aujourd'hui, decks et promos ; pour
 * chacune, sa page : son nom, sa date de sortie au Japon, et toutes ses cartes, dresseurs et
 * énergies compris (numéro, noms français, anglais et allemand, Pokémon, id Cardmarket, rang de son
 * image, rareté, type, illustrateur, versions), les noms des raretés et le menu des séries (le bloc
 * de chacune). Aucune sélection ni détection : la rareté et le type servent aux filtres que choisit
 * l'utilisateur.
 *
 * Les exclusivités d'autres pays d'Asie (bloc « Asia Exclusive » de son menu), rangées avec les
 * japonaises, sont écartées. Une série est relue après une semaine, après un jour si elle est
 * sortie depuis moins de 90 jours (Pokécardex la complète) ; `--refresh` les relit toutes. Une page
 * par série, une toutes les 3 s : le premier passage prend une vingtaine de minutes. Une page en
 * échec n'empêche pas les autres ; la tâche échoue ensuite, pour être relancée. Une page soudain
 * vide (le site a changé) ne retire rien. Au début et en fin de tâche, les réponses du catalogue
 * sont recalculées (`snapshots`) : `/v1/catalog/species/<n°>` (les cartes d'un Pokémon : la fenêtre
 * d'ajout), `/v1/catalog/sets` (les séries) et `/v1/catalog/sets/<code>` (toutes les cartes d'une
 * série : la page Catalogue, l'image d'une référence).
 */

import type { Database } from 'bun:sqlite'
import { TOTAL_SPECIES } from '@/config/pokedex'
import { DAY, HOUR } from '@/lib/time'
import type {
  CatalogFile,
  CatalogRow,
  CatalogSetFile,
  CatalogSetRow,
  CatalogSetsFile,
} from '@/contract'
import { refresh } from '../lib/net'
import {
  asiaExclusive,
  japaneseSeries,
  menuBlocks,
  readSeries,
  type PokecardexCard,
  type PokecardexSeries,
} from '../lib/pokecardex'
import { saveSnapshot } from '../snapshots'

/**
 * Un numéro comparable : `017` et `17` sont la même carte, `tg01` et `TG01` aussi (la même règle
 * que la référence d'une carte dans le site).
 */
const numberKey = (number: string) =>
  /^\d+$/.test(number) ? String(Number(number)) : number.toUpperCase()

/**
 * Autant de pages en échec d'affilée : le site a changé (clé introuvable, défi anti-robot…), on ne
 * le sollicite pas davantage ; la tâche est relancée plus tard.
 */
const MAX_FAILURES_IN_A_ROW = 10

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

/** Le préfixe des réponses de chaque série : `catalog/sets/SV2A`. */
const SET_SNAPSHOT = 'catalog/sets/'

/** Le préfixe des réponses de chaque Pokémon : `catalog/species/25`. */
const SPECIES_SNAPSHOT = 'catalog/species/'

/**
 * Enregistre les réponses du catalogue, d'après les tables ; rien tant qu'aucune carte n'a été lue :
 * un catalogue vide passerait pour disponible (l'API répond 404 en attendant).
 */
export function saveCatalog(db: Database) {
  if (!db.query('SELECT 1 FROM cards LIMIT 1').get()) return
  const sets = (
    db
      .query(
        `SELECT id, name, released, logo, block, block_rank AS blockRank, deck FROM sets
         WHERE id IN (SELECT set_id FROM cards)`,
      )
      .all() as SetRecord[]
  )
    // Des plus récentes aux plus anciennes ; sorties le même jour, dans l'ordre de leur code.
    .sort((a, b) => b.released.localeCompare(a.released) || a.id.localeCompare(b.id))
  const cards = db
    .query(
      `SELECT set_id AS 'set', number, printed, sort, name, name_en AS en, name_de AS de,
              cardmarket, image, rarity, type, illustrator, versions,
              (SELECT json_group_array(dex_id ORDER BY rank) FROM card_species
               WHERE card = id) AS dexIds
       FROM cards ORDER BY sort`,
    )
    .all() as CardRecord[]
  const rarities = new Map(
    (db.query('SELECT id, name, rank FROM rarities').all() as RarityRecord[]).map((rarity) => [
      rarity.id,
      rarity,
    ]),
  )
  const bySet = new Map<string, CardRecord[]>()
  for (const card of cards) {
    const list = bySet.get(card.set)
    if (list) list.push(card)
    else bySet.set(card.set, [card])
  }
  const byId = new Map(sets.map((set) => [set.id, set]))
  const bySpecies = cardsBySpecies(cards, byId)
  db.transaction(() => {
    // Chaque Pokémon, même sans carte : la fenêtre d'ajout dit alors qu'il n'en a pas (404 :
    // catalogue pas disponible).
    for (let dexId = 1; dexId <= TOTAL_SPECIES; dexId++) {
      saveSnapshot(
        db,
        `${SPECIES_SNAPSHOT}${dexId}`,
        speciesResponse(dexId, bySpecies[dexId] ?? [], byId, rarities),
      )
    }
    saveSnapshot(db, 'catalog/sets', setsResponse(sets, bySet))
    for (const set of sets) {
      saveSnapshot(db, `${SET_SNAPSHOT}${set.id}`, setResponse(bySet.get(set.id)!, rarities))
    }
    // Celles des séries qui n'ont plus de cartes : retirées (l'API répond 404).
    db.query(
      `DELETE FROM snapshots WHERE name LIKE '${SET_SNAPSHOT}%'
       AND name NOT IN (SELECT '${SET_SNAPSHOT}' || set_id FROM cards)`,
    ).run()
  })()
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
 * cherchée : celle de Pokécardex, qui les a presque toutes (le serveur la copie à la demande ; sans
 * elle, la carte de substitution).
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

/** Les séries à relire : nouvelles, lues il y a plus d'une semaine, ou d'un jour si récentes. */
function dueSeries(db: Database, codes: string[], now: number) {
  if (refresh) return codes
  const known = new Map(
    (
      db.query('SELECT id, released, read_at AS readAt FROM sets').all() as {
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
    // Un peu moins qu'un jour et qu'une semaine : la tâche repasse toutes les 24 h.
    return now - Date.parse(set.readAt) > (recent ? 20 * HOUR : 6 * DAY + 20 * HOUR)
  })
}

/**
 * L'écriture de ce que donnent les pages de Pokécardex, requêtes préparées une fois : une série et
 * ses cartes, les raretés, le bloc de chaque série.
 */
function seriesWriter(db: Database) {
  const writeSet = db.query(
    `INSERT INTO sets (id, name, released, read_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, released = excluded.released,
                                    read_at = excluded.read_at`,
  )
  // Une carte dont la série ou le rang changent a une autre image : à chercher de nouveau.
  const writeCard = db.query(
    `INSERT INTO cards (id, set_id, number, printed, sort, name, name_en, name_de, cardmarket,
                        rarity, type, illustrator, versions, seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
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
    `INSERT INTO rarities (id, name, rank) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, rank = excluded.rank`,
  )
  const writeBlock = db.query('UPDATE sets SET block = ?, block_rank = ?, deck = ? WHERE id = ?')
  const clearSpecies = db.query('DELETE FROM card_species WHERE card = ?')
  const writeSpecies = db.query('INSERT INTO card_species (card, rank, dex_id) VALUES (?, ?, ?)')
  const countCards = db.query('SELECT COUNT(*) AS count FROM cards WHERE set_id = ?')
  const forget = db.query('DELETE FROM cards WHERE set_id = ? AND seen != ?')
  /** Le nombre de cartes de la série déjà en base. */
  const known = (code: string) => (countCards.get(code) as { count: number }).count

  /** La page d'une série, enregistrée d'un coup : son nombre de cartes. */
  const save = db.transaction((code: string, page: PokecardexSeries, readAt: string) => {
    const before = known(code)
    const { fullName, releaseDateFR } = page.currentSeries
    writeSet.run(code, fullName, releaseDateFR?.slice(0, 10) ?? '', readAt)
    // Le numéro imprimé, sinon le rang. Si deux cartes de la série se confondraient (deux
    // demi-decks numérotés chacun : HS ; cartes géantes de séries diverses : JUMBO), toutes
    // prennent leur rang.
    const keys = page.cartes.map((card) =>
      numberKey(printedNumber(card.num_card) || `${card.sort}`),
    )
    const distinct = new Set(keys).size === keys.length
    const numberOf = (card: PokecardexCard) => (distinct ? printedNumber(card.num_card) : '')
    for (const card of page.cartes) {
      const dexIds = (card.id_pokedex_list ?? []).filter(
        (id) => Number.isInteger(id) && id >= 1 && id <= TOTAL_SPECIES,
      )
      const english = stated(card.name_card_en)
      writeCard.run(
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
      clearSpecies.run(card.id_card)
      dexIds.forEach((dexId, rank) => writeSpecies.run(card.id_card, rank, dexId))
    }
    const saved = page.cartes.length
    // Moins de la moitié des cartes d'avant : le format des pages a changé (un champ renommé),
    // pas l'extension. Rien n'est gardé de cette lecture (la transaction est annulée) : elle
    // compte comme un échec.
    if (saved < before / 2) {
      throw new Error(
        `${code} : ${saved} cartes retenues sur ${before} (format des pages changé ?)`,
      )
    }
    forget.run(code, readAt)
    return saved
  })

  return {
    known,
    save,
    /** Les raretés, que chaque page donne toutes. */
    rarities(page: PokecardexSeries) {
      for (const rarity of page.raretes ?? []) {
        writeRarity.run(rarity.id_rarete, rarity.nom_rarete, rarity.order_rarete)
      }
    },
    /** Le bloc de chaque série, d'après le menu : ses séries en boosters, puis ses decks. */
    blocks(menu: PokecardexSeries) {
      for (const [rank, block] of menuBlocks(menu).entries()) {
        for (const series of block.series) writeBlock.run(block.name, rank, 0, series.shortName)
        for (const deck of block.decks ?? []) writeBlock.run(block.name, rank, 1, deck.shortName)
      }
    },
    /** Une série retirée, avec ses cartes. */
    remove(code: string) {
      db.query('DELETE FROM cards WHERE set_id = ?').run(code)
      db.query('DELETE FROM sets WHERE id = ?').run(code)
    },
  }
}

/** Ce que ce passage a relu, et ce que compte le catalogue en tout. */
function logTotals(db: Database, read: number, cards: number) {
  const totals = db
    .query(
      `SELECT COUNT(*) AS cards, SUM(cardmarket = 0) AS withoutCardmarket,
              SUM(number != '' AND CAST(number AS INTEGER) != sort) AS otherNumber
       FROM cards`,
    )
    .get() as { cards: number; withoutCardmarket: number | null; otherNumber: number | null }
  console.log(
    `Catalogue : ${read} séries relues (${cards} cartes) ; ` +
      `${totals.cards} cartes en tout, ${totals.withoutCardmarket ?? 0} sans id Cardmarket, ` +
      `${totals.otherNumber ?? 0} dont le numéro imprimé n’est pas le rang de l’image`,
  )
}

export async function catalog(db: Database) {
  // La réponse d'après les tables, tout de suite : une forme changée avec le code (ou retirée par
  // une étape du schéma) est refaite sans attendre la lecture des séries (une vingtaine de minutes
  // quand toutes sont à relire).
  saveCatalog(db)
  const codes = await japaneseSeries()
  const due = dueSeries(db, codes, Date.now())
  console.log(`Pokécardex : ${codes.length} séries japonaises, ${due.length} à relire`)

  const writer = seriesWriter(db)
  const failed: string[] = []
  let inARow = 0
  let cards = 0
  let read = 0
  // Les séries qui avaient déjà des cartes, relues, et celles d'entre elles rendues sans cartes.
  let knownRead = 0
  let knownEmpty = 0
  // Les exclusivités d'autres pays d'Asie et les blocs, d'après le menu de la première page lue, et
  // les raretés, que chaque page donne toutes.
  let asian = new Set<string>()
  let menu: PokecardexSeries | null = null
  for (const [index, code] of due.entries()) {
    if (asian.has(code)) continue
    try {
      const page = await readSeries(code)
      if (!menu) {
        menu = page
        asian = asiaExclusive(page)
        writer.rarities(page)
      }
      if (asian.has(code)) continue
      const known = writer.known(code)
      if (known) knownRead++
      // Une page sans cartes : une série annoncée mais pas encore remplie, ou le site a changé (on
      // garde alors celles d'avant). Rien n'est noté : elle est relue au passage suivant.
      if (!page.cartes?.length) {
        if (known) {
          knownEmpty++
          console.warn(`  ${code} : page sans cartes, les ${known} d’avant restent`)
        }
        continue
      }
      cards += writer.save(code, page, new Date().toISOString())
      read++
      inARow = 0
    } catch (error) {
      failed.push(code)
      console.warn(`  ${code} :`, error instanceof Error ? error.message : error)
      if (++inARow >= MAX_FAILURES_IN_A_ROW) {
        console.warn(`  ${inARow} séries en échec d’affilée : la lecture s’arrête là.`)
        break
      }
    }
    if ((index + 1) % 50 === 0) console.log(`  ${index + 1} / ${due.length} séries`)
  }
  // Celles qu'un passage d'avant aurait gardées : retirées.
  for (const code of asian) writer.remove(code)
  // Le bloc de chaque série, les nouvelles comprises (enregistrées depuis).
  if (menu) writer.blocks(menu)

  logTotals(db, read, cards)
  saveCatalog(db)
  if (failed.length) {
    throw new Error(`${failed.length} séries illisibles (${failed.slice(0, 10).join(', ')})`)
  }
  // Plus de la moitié des séries déjà connues rendues sans cartes : le format des pages a changé
  // (le champ des cartes renommé), pas les séries. Leurs cartes d'avant restent ; la tâche échoue,
  // pour que la page Données et la surveillance le disent (sinon, un catalogue figé sans un mot).
  if (knownEmpty > 0 && knownEmpty * 2 > knownRead) {
    throw new Error(
      `${knownEmpty} séries sur ${knownRead} déjà connues rendues sans cartes (format des pages changé ?)`,
    )
  }
}
