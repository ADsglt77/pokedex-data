/**
 * La base SQLite des données, `data.db` dans `DATA_DIR` (`.data/` en local, le volume `data` sur le
 * VPS) : les données de référence (catalogue, prix, historique…), écrites par les tâches
 * d'ingestion (`ingest.ts`) seulement ; l'API la lit (elle n'y applique que les étapes du schéma
 * qui manquent, à son démarrage). Reprise du Pokédex telle quelle, étapes comprises.
 * Le schéma évolue par étapes (`PRAGMA user_version`) : une étape ajoutée ne modifie jamais les
 * précédentes, déjà appliquées. L'empreinte de chacune est gardée (`schema_steps`) : une étape
 * modifiée après coup (enregistrée à moitié pendant que `bun --watch` relance le serveur), ou une
 * base plus avancée que le code (un code plus ancien redéployé), et le serveur refuse de démarrer.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dirname, '..', '.data')

/**
 * L'étape qui donne leurs empreintes aux bases d'avant elles (`migrate` les note en appliquant
 * une étape).
 */
const FINGERPRINTS_STEP = `
  -- L'empreinte de chaque étape appliquée (\`migrate\`) : une étape modifiée après coup est refusée.
  CREATE TABLE IF NOT EXISTS schema_steps (step INTEGER PRIMARY KEY, hash TEXT NOT NULL);
  `

export const DATA_STEPS = [
  `
  -- Ce qu'on a lu de chaque source à son dernier passage : \`stamp\`, sa date de mise à jour (pour
  -- ne pas la retélécharger si elle n'a pas changé), et \`date\`, le jour de ses données.
  CREATE TABLE sources (name TEXT PRIMARY KEY, stamp TEXT NOT NULL, date TEXT NOT NULL);

  -- Le journal des tâches : \`ok\` et \`finished_at\` restent nuls tant qu'elle tourne.
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    job TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    ok INTEGER,
    message TEXT
  );
  CREATE INDEX runs_by_job ON runs (job, id);

  -- Le prix du jour de chaque carte Cardmarket (tendance, sinon moyenne 30 jours), par id produit.
  CREATE TABLE cardmarket_prices (
    id INTEGER PRIMARY KEY,
    price REAL NOT NULL,
    low REAL,
    avg30 REAL
  );

  -- Le nom de chaque produit Cardmarket (liste publique des produits).
  CREATE TABLE cardmarket_products (id INTEGER PRIMARY KEY, name TEXT NOT NULL);

  -- L'historique : un prix par jour (\`null\` sans prix), un tableau JSON par carte et par année,
  -- à partir du jour de l'année \`first\` (0 : 1er janvier), celui de son premier prix. Une ligne
  -- par année : la mise à jour du jour ne réécrit jamais des années entières.
  CREATE TABLE cardmarket_history (
    id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    first INTEGER NOT NULL,
    prices TEXT NOT NULL,
    PRIMARY KEY (id, year)
  ) WITHOUT ROWID;

  -- Le prix du jour chez TCGplayer, converti en euros, des cartes du catalogue sans prix
  -- Cardmarket, par code (\`codeKey\` : « E1 97 »).
  CREATE TABLE tcgplayer_prices (code TEXT PRIMARY KEY, price REAL NOT NULL, low REAL) WITHOUT ROWID;

  -- Dollars pour un euro, au cours de référence de la Banque centrale européenne.
  CREATE TABLE rates (date TEXT PRIMARY KEY, usd_per_eur REAL NOT NULL);

  -- Les réponses volumineuses de l'API, calculées en fin de tâche et compressées (gzip).
  CREATE TABLE snapshots (name TEXT PRIMARY KEY, etag TEXT NOT NULL, body BLOB NOT NULL);
  `,
  `
  -- Le catalogue des cartes Pokémon japonaises (tâche \`catalog\`, d'après TCGdex) : les extensions
  -- de ses cartes (\`released\` : '' si TCGdex ne la donne pas ; \`tcgplayer_groups\` : JSON, les
  -- groupes TCGplayer de leurs cartes, où lire le prix de celles sans prix Cardmarket)…
  CREATE TABLE sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    released TEXT NOT NULL,
    tcgplayer_groups TEXT NOT NULL
  );

  -- … ses cartes (\`key\` : « SV2a 166 », l'extension et le numéro chez TCGdex ; \`cardmarket\` : 0
  -- si inconnu ou douteux ; \`tcgplayer\` : le produit TCGplayer, 0 sans ; \`seen\` : le dernier
  -- passage qui l'a vue, une carte que TCGdex ne donne plus est retirée)…
  CREATE TABLE cards (
    key TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    number TEXT NOT NULL,
    suffix TEXT NOT NULL,
    cardmarket INTEGER NOT NULL,
    tcgplayer INTEGER NOT NULL,
    seen TEXT NOT NULL
  );

  -- … et leurs Pokémon, dans l'ordre (plusieurs pour une carte TAG TEAM).
  CREATE TABLE card_species (
    card TEXT NOT NULL REFERENCES cards (key) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    dex_id INTEGER NOT NULL,
    PRIMARY KEY (card, rank)
  ) WITHOUT ROWID;
  `,
  `
  -- L'image de chaque carte, copiée chez nous par la tâche \`images\` : \`pokecardex\`, \`tcgplayer\`
  -- (celle de son produit, quand Pokécardex n'a pas la sienne) ou \`none\` ; nulle tant qu'elle n'a
  -- pas été cherchée. \`image_checked\` : le jour où elle l'a été (sans scan Pokécardex, elle est
  -- recherchée chaque semaine).
  ALTER TABLE cards ADD COLUMN image TEXT;
  ALTER TABLE cards ADD COLUMN image_checked TEXT;
  `,
  `
  -- D'où vient chaque carte du catalogue : \`tcgdex\`, ou \`tcgplayer\` pour celles que TCGdex n'a
  -- pas (decks, promos…).
  ALTER TABLE cards ADD COLUMN source TEXT NOT NULL DEFAULT 'tcgdex';
  `,
  `
  -- Les espèces (tâche \`species\`, d'après PokéAPI), jamais lues : l'API sert les réponses que la
  -- tâche calcule (\`snapshots\`). Retirée plus bas.
  CREATE TABLE species (id INTEGER PRIMARY KEY, data TEXT NOT NULL, details TEXT NOT NULL);
  `,
  `
  -- Le catalogue vient de Pokécardex (octobre 2026) : TCGdex et TCGplayer sont retirés, avec la BCE
  -- qui convertissait les prix de TCGplayer. La tâche \`catalog\` le refait entièrement.
  DROP TABLE card_species;
  DROP TABLE cards;
  DROP TABLE sets;
  DROP TABLE tcgplayer_prices;
  DROP TABLE rates;
  DELETE FROM sources WHERE name IN ('catalog', 'tcgplayer');
  DELETE FROM snapshots WHERE name = 'catalog';

  -- Les séries japonaises de Pokécardex : leur code (« SV2A »), leur nom, leur sortie au Japon
  -- (YYYY-MM-DD, '' si inconnue), et la dernière lecture de leur page.
  CREATE TABLE sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    released TEXT NOT NULL,
    read_at TEXT NOT NULL
  );

  -- Leurs cartes Pokémon, par leur id chez Pokécardex : le numéro imprimé (« 001 » ; sans numéro,
  -- leur rang), leur rang dans la série (\`sort\`, aussi le numéro de leur image), leur nom
  -- français, leur id Cardmarket (0 : aucun), la lecture qui les a vues (\`seen\` : une carte
  -- qu'une lecture de sa série ne voit plus est retirée). \`image\` : \`pokecardex\` ou \`none\`, nulle
  -- tant qu'elle n'a pas été cherchée par la tâche \`images\` ; \`image_checked\` : quand.
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES sets (id),
    number TEXT NOT NULL,
    sort INTEGER NOT NULL,
    name TEXT NOT NULL,
    cardmarket INTEGER NOT NULL,
    seen TEXT NOT NULL,
    image TEXT,
    image_checked TEXT
  );
  CREATE INDEX cards_by_set ON cards (set_id);

  -- Leurs Pokémon, dans l'ordre (plusieurs pour une carte TAG TEAM).
  CREATE TABLE card_species (
    card INTEGER NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    dex_id INTEGER NOT NULL,
    PRIMARY KEY (card, rank)
  ) WITHOUT ROWID;
  `,
  `
  -- La table des espèces, que rien ne lisait (l'API sert les réponses de la tâche \`species\`,
  -- \`snapshots\`), et la source \`catalog\`, qui ne disait que « au moins une carte lue » (la
  -- table \`cards\` le dit) : retirées.
  DROP TABLE species;
  DELETE FROM sources WHERE name = 'catalog';
  `,
  `
  -- L'extension et la « métacarte » (la même carte, d'une extension à l'autre) de chaque produit
  -- Cardmarket, d'après sa liste des produits : les produits d'une même métacarte dans une même
  -- extension en sont les versions (V.1, V.2…), qu'écrit sa ligne pour une liste de souhaits
  -- (\`/api/wants\`). Nulles pour un produit que la liste ne donne pas (ou plus).
  ALTER TABLE cardmarket_products ADD COLUMN expansion INTEGER;
  ALTER TABLE cardmarket_products ADD COLUMN metacard INTEGER;
  CREATE INDEX cardmarket_products_by_card ON cardmarket_products (expansion, metacard);
  -- Pour les remplir : le prochain passage de la tâche \`prices\` relit le guide et la liste des
  -- produits, même si le guide n'a pas changé.
  UPDATE sources SET stamp = '' WHERE name = 'cardmarket';

  -- Les cartes du catalogue d'un produit Cardmarket : le nom de son extension (\`/api/wants\`).
  CREATE INDEX cards_by_cardmarket ON cards (cardmarket);
  `,
  `
  -- La rareté et le type de chaque carte, numérotés par Pokécardex (les types : \`CARD_TYPES\`,
  -- \`src/config/catalog.ts\`), et ses raretés : leur nom et leur ordre.
  ALTER TABLE cards ADD COLUMN rarity INTEGER;
  ALTER TABLE cards ADD COLUMN type INTEGER;
  CREATE TABLE rarities (id INTEGER PRIMARY KEY, name TEXT NOT NULL, rank INTEGER NOT NULL);
  -- Le logo japonais de chaque série, copié chez nous par la tâche \`images\` : \`pokecardex\` ou
  -- \`none\`, nul tant qu'il n'a pas été cherché.
  ALTER TABLE sets ADD COLUMN logo TEXT;
  ALTER TABLE sets ADD COLUMN logo_checked TEXT;
  -- Pour les remplir : le prochain passage de la tâche \`catalog\` relit toutes les séries.
  UPDATE sets SET read_at = '1970-01-01T00:00:00.000Z';
  `,
  `
  -- La réponse de \`/api/catalog\` d'avant la rareté, le type et le logo : le navigateur ne sait
  -- plus la lire. Retirée : l'API répond 404 (« pas disponible ») jusqu'à ce que la tâche
  -- \`catalog\` la refasse, dès son démarrage (ou la boucle d'ingestion, à la sienne).
  DELETE FROM snapshots WHERE name = 'catalog';
  `,
  `
  -- Toutes les cartes de chaque série, dresseurs et énergies compris (sans Pokémon : rien dans
  -- \`card_species\`), avec ce que Pokécardex en dit de plus, pour la page Catalogue : le numéro
  -- tel qu'imprimé (« 006/165 » ; '' sans numéro), leurs noms anglais et allemand, leur
  -- illustrateur, leurs versions (JSON : « Standard », « Reverse »…).
  ALTER TABLE cards ADD COLUMN printed TEXT NOT NULL DEFAULT '';
  ALTER TABLE cards ADD COLUMN name_en TEXT NOT NULL DEFAULT '';
  ALTER TABLE cards ADD COLUMN name_de TEXT NOT NULL DEFAULT '';
  ALTER TABLE cards ADD COLUMN illustrator TEXT NOT NULL DEFAULT '';
  ALTER TABLE cards ADD COLUMN versions TEXT NOT NULL DEFAULT '[]';
  -- Le bloc de chaque série dans le menu de Pokécardex (« Scarlet & Violet ») et son rang dans
  -- le menu, nuls s'il ne la range pas ; \`deck\` : 1 pour un deck, 0 pour une série en boosters.
  ALTER TABLE sets ADD COLUMN block TEXT;
  ALTER TABLE sets ADD COLUMN block_rank INTEGER;
  ALTER TABLE sets ADD COLUMN deck INTEGER NOT NULL DEFAULT 0;
  -- Pour les remplir : le prochain passage de la tâche \`catalog\` relit toutes les séries.
  UPDATE sets SET read_at = '1970-01-01T00:00:00.000Z';
  `,
  `
  -- Les prix de toutes les cartes de Cardmarket (\`/api/prices\`, 1,6 Mo) : l'app ne demande plus
  -- que ceux de ses cartes (\`/api/prices/collection\`, \`/api/prices/selection\`).
  DELETE FROM snapshots WHERE name = 'prices';
  -- Chaque réponse aussi compressée en Brotli, servie au navigateur qui l'accepte (nulle : pas
  -- encore recompressée, la tâche la refait à son prochain passage).
  ALTER TABLE snapshots ADD COLUMN brotli BLOB;
  -- Le catalogue entier (\`/api/catalog\`, 930 Ko) : la fenêtre d'ajout ne lit plus que les cartes
  -- de son Pokémon (\`/api/catalog/species/<n°>\`), l'image d'une référence que sa série.
  DELETE FROM snapshots WHERE name = 'catalog';
  `,
  FINGERPRINTS_STEP,
  `
  -- Les prix suivent la règle de Pokécardex (octobre 2026), dont l'historique est repris
  -- (\`jobs/history.ts\`) : la moyenne sur 30 jours devient le prix du jour, et sa place prend le
  -- prix d'il y a 30 jours (\`month_ago\`, d'après l'historique ; nul jusqu'au prochain guide). Le
  -- \`Last-Modified\` du guide oublié : le prochain passage de la tâche \`prices\` le relit.
  ALTER TABLE cardmarket_prices RENAME COLUMN avg30 TO month_ago;
  UPDATE cardmarket_prices SET month_ago = NULL;
  UPDATE sources SET stamp = '' WHERE name = 'cardmarket';
  -- Les cartes dont l'historique a été repris de Pokécardex (une fois chacune) : la tâche
  -- \`history\` reprend là où elle s'est arrêtée.
  CREATE TABLE history_imports (card INTEGER PRIMARY KEY, read_at TEXT NOT NULL) WITHOUT ROWID;
  `,
]

const userVersion = (db: Database) =>
  (db.query('PRAGMA user_version').get() as { user_version: number }).user_version

/** L'empreinte d'une étape : son texte, tel qu'appliqué. */
const fingerprint = (step: string) => new Bun.CryptoHasher('sha256').update(step).digest('hex')

/**
 * Applique les étapes du schéma pas encore passées, une transaction chacune, avec leur empreinte
 * (et celle des étapes appliquées avant les empreintes, au premier passage). À jour, aucun verrou :
 * l'autre processus peut tenir une longue écriture sans faire échouer ce démarrage ; les
 * empreintes gardées sont seulement relues. Une étape modifiée depuis son application, ou une base
 * plus avancée que `steps` : une erreur qui le dit, et rien n'est appliqué.
 */
export function migrate(db: Database, name: string, steps: string[]) {
  const reached = userVersion(db)
  if (reached > steps.length) {
    throw new Error(
      `${name} en est à l’étape ${reached} du schéma, ce code n’en connaît que ${steps.length} (un code plus ancien ?)`,
    )
  }
  const known = db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_steps'",
  )
  if (known.get()) {
    const recorded = db.query('SELECT step, hash FROM schema_steps').all() as {
      step: number
      hash: string
    }[]
    for (const { step, hash } of recorded) {
      if (step <= reached && hash !== fingerprint(steps[step - 1]!)) {
        throw new Error(
          `${name} : l’étape ${step} du schéma a changé depuis son application. Remettez son texte d’origine et ajoutez une nouvelle étape (une étape enregistrée à moitié pendant que le serveur tournait ? reprenez la base)`,
        )
      }
    }
  }
  while (userVersion(db) < steps.length) {
    const applied = db.transaction(() => {
      const version = userVersion(db)
      const step = steps[version]
      if (step === undefined) return false
      db.run(step)
      db.run(`PRAGMA user_version = ${version + 1}`)
      db.run(
        'CREATE TABLE IF NOT EXISTS schema_steps (step INTEGER PRIMARY KEY, hash TEXT NOT NULL)',
      )
      const record = db.query('INSERT OR IGNORE INTO schema_steps (step, hash) VALUES (?, ?)')
      for (let index = 0; index <= version; index++) {
        record.run(index + 1, fingerprint(steps[index]!))
      }
      return true
    })
    // `immediate` : deux processus qui démarrent ensemble n'appliquent pas la même étape.
    if (!applied.immediate()) return
  }
}

/** Ce qu'on a lu d'une source à son dernier passage (table `sources`). */
interface Source {
  /** Sa date de mise à jour, telle qu'elle la donne : inchangée, rien n'est retéléchargé. */
  stamp: string
  /** Le jour de ses données (YYYY-MM-DD). */
  date: string
}

export const readSource = (db: Database, name: string) =>
  db.query('SELECT stamp, date FROM sources WHERE name = ?').get(name) as Source | null

export function writeSource(db: Database, name: string, { stamp, date }: Source) {
  db.query(
    `INSERT INTO sources (name, stamp, date) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET stamp = excluded.stamp, date = excluded.date`,
  ).run(name, stamp, date)
}

/**
 * La base des données de référence. `readonly` (l'API) : le schéma est mis à jour, puis la
 * connexion refuse toute écriture.
 */
export function openData({ readonly = false } = {}) {
  mkdirSync(DATA_DIR, { recursive: true })
  const db = new Database(join(DATA_DIR, 'data.db'), { create: true, strict: true })
  // Avant le passage en WAL : à la création de la base, l'autre processus qui démarre en même
  // temps la verrouille un instant, et ce passage échouerait tout de suite.
  db.run('PRAGMA busy_timeout = 5000')
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA foreign_keys = ON')
  // Le journal WAL retombe à 64 Mo après une grosse écriture (l'historique des prix du jour).
  db.run('PRAGMA journal_size_limit = 67108864')
  migrate(db, 'data.db', DATA_STEPS)
  if (readonly) db.run('PRAGMA query_only = ON')
  return db
}
