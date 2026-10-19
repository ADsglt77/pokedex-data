/**
 * Tâche `backups` : chaque jour, une copie de la base dans `BACKUP_DIR` (le volume `backups` sur
 * le VPS, `.data/backups` en local), `data-AAAA-MM-JJ.db.gz` (compressée ; 7 gardées), dont
 * l'historique des prix, irremplaçable. Faite par SQLite pendant que l'API tourne (`VACUUM INTO` :
 * une copie cohérente, compacte), vérifiée (`PRAGMA quick_check`), puis mise à sa place d'un coup :
 * une copie des sauvegardes hors du VPS (README) qui passerait pendant l'écriture n'emporte jamais
 * un fichier à moitié écrit (ceux en cours commencent par `tmp-`). Le volume est sur le même
 * disque que la base : en copier le contenu ailleurs (README).
 * Restaurer : README, « Restaurer une sauvegarde ».
 */

import { Database } from 'bun:sqlite'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { DATA_DIR } from '../db'

const BACKUP_DIR = process.env.BACKUP_DIR ?? join(DATA_DIR, 'backups')

/** Une copie lisible et saine ; sinon une erreur (la tâche échoue, `/v1/status` le dit). */
function check(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    const { quick_check: result } = db.query('PRAGMA quick_check').get() as {
      quick_check: string
    }
    if (result !== 'ok') throw new Error(`Copie abîmée (${file}) : ${result}`)
  } finally {
    db.close()
  }
}

export async function backups(db: Database) {
  const day = new Date().toISOString().slice(0, 10)
  await mkdir(BACKUP_DIR, { recursive: true })
  // Les restes d'une copie interrompue (redémarrage pendant l'écriture).
  for (const file of await readdir(BACKUP_DIR)) {
    if (file.startsWith('tmp-')) await rm(join(BACKUP_DIR, file), { force: true })
  }

  const name = `data-${day}.db`
  // En cours d'écriture : jamais pris pour une sauvegarde.
  const plain = join(BACKUP_DIR, `tmp-${name}`)
  try {
    db.run(`VACUUM INTO '${plain.replaceAll("'", "''")}'`)
    check(plain)
    // En flux : la base grossit avec l'historique, elle ne passe pas entière en mémoire.
    await pipeline(createReadStream(plain), createGzip(), createWriteStream(`${plain}.gz`))
    await rename(`${plain}.gz`, join(BACKUP_DIR, `${name}.gz`))
  } finally {
    await rm(plain, { force: true })
    await rm(`${plain}.gz`, { force: true })
  }
  // Les 7 plus récentes (leur nom porte leur jour).
  const kept = (await readdir(BACKUP_DIR)).filter((file) => file.startsWith('data-')).sort()
  for (const file of kept.slice(0, -7)) await rm(join(BACKUP_DIR, file))
}
