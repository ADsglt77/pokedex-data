/**
 * Avant le premier fichier de test (`bunfig.toml`) : l'environnement de l'API. `src/db.ts` lit son
 * dossier (`DATA_DIR`) à son chargement, et `bun test` ne charge un module qu'une fois pour tous
 * les fichiers, dans un ordre imprévisible : posées par un fichier de test, ces variables
 * arriveraient parfois trop tard. Un dossier temporaire, retiré à la fin, jamais `.data`.
 */

import { Database } from 'bun:sqlite'
import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'pokedex-data-tests-'))
process.env.DATA_DIR = dir
// Les images et les sauvegardes aussi : jamais celles du `.env`.
process.env.IMAGES_DIR = join(dir, 'images')
process.env.BACKUP_DIR = join(dir, 'backups')
// Bun ne garde en cache que les 20 premières requêtes compilées d'une base (`db.query`) ; les
// suivantes ne le sont jamais, et `close()` ne les ferme pas : sous Windows, la base resterait
// ouverte et le dossier ne se retirerait pas. Les tests d'un fichier en compilent davantage.
Database.MAX_QUERY_CACHE_SIZE = 1000

afterAll(() => rmSync(dir, { recursive: true, force: true }))
