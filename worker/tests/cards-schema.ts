/**
 * La base de l'importateur (`CARDS`) dans les tests : seulement les tables et les colonnes que lit
 * la tâche `catalog`, telles que les écrit `../pokecodex-api/migrations/` (copiées ici : la
 * construction de Cloudflare n'a que ce dépôt), et les colonnes des logos que l'importateur ajoute
 * (novembre 2026), nulles tant qu'il ne les a pas remplies. Appliquée par `setup.ts`.
 */

export const CARDS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS series (
     id         TEXT PRIMARY KEY,
     tcgdex_id  TEXT NOT NULL,
     language   TEXT NOT NULL CHECK (language IN ('fr', 'ja')),
     name       TEXT NOT NULL,
     UNIQUE (language, tcgdex_id)
   )`,
  `CREATE TABLE IF NOT EXISTS sets (
     id             TEXT PRIMARY KEY,
     tcgdex_id      TEXT NOT NULL,
     series_id      TEXT REFERENCES series (id),
     language       TEXT NOT NULL CHECK (language IN ('fr', 'ja')),
     name           TEXT NOT NULL,
     release_date   TEXT,
     official_cards INTEGER,
     logo_status    TEXT,
     logo_r2_key    TEXT,
     UNIQUE (language, tcgdex_id)
   )`,
  `CREATE TABLE IF NOT EXISTS cards (
     id            TEXT PRIMARY KEY,
     tcgdex_id     TEXT NOT NULL,
     language      TEXT NOT NULL CHECK (language IN ('fr', 'ja')),
     name          TEXT NOT NULL,
     local_id      TEXT NOT NULL,
     set_id        TEXT REFERENCES sets (id),
     rarity        TEXT,
     category      TEXT,
     illustrator   TEXT,
     image_r2_key  TEXT,
     image_status  TEXT NOT NULL DEFAULT 'pending' CHECK (image_status IN (
                     'pending', 'downloaded', 'recovered_from_cdn', 'already_present',
                     'missing_api_url', 'not_found_on_cdn', 'download_error', 'invalid_image')),
     metadata_json TEXT NOT NULL DEFAULT '{}',
     removed_at    TEXT,
     UNIQUE (language, tcgdex_id)
   )`,
]
