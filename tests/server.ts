/**
 * La base pour les tests : dans le dossier temporaire de `setup.ts`, jamais `.data`. La garde est
 * ici, une fois : sans `setup.ts` (`bun test` lancé hors du projet), `DATA_DIR` reviendrait à
 * `.data`, et rien n'est ouvert. Chaque fichier qui en a besoin ouvre la sienne, fermée après ses
 * tests (pour que `setup.ts` retire son dossier).
 */

import { afterAll } from 'bun:test'
import { tmpdir } from 'node:os'
import { DATA_DIR, openData } from '../src/db'

if (!DATA_DIR.startsWith(tmpdir())) throw new Error(`DATA_DIR n’est pas temporaire : ${DATA_DIR}`)

/** La base des données de référence (prix, catalogue…), fermée après les tests du fichier. */
export function testData() {
  const data = openData()
  afterAll(() => data.close())
  return data
}
