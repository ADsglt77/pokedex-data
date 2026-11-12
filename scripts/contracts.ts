/**
 * Le contrôle du contrat, lancé par `bun run lint` : les types partagés avec le site (la copie de
 * `src/contract.ts` dans `../pokedex/src/types.ts`) doivent rester égaux, vérifiés par
 * `bun run contracts` du site (`../pokedex/scripts/check-data-contracts.ts`, ses paquets installés).
 * Seulement quand le site est à côté (le poste du développeur) : la construction de Cloudflare n'a
 * que ce dépôt, et le dit (« Contrat non vérifié »). Le contrôle porte sur `../pokedex-data` vu du
 * site : la copie de travail d'à côté, pas forcément celle-ci (une copie ailleurs, une worktree).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const site = join(import.meta.dir, '..', '..', 'pokedex')

if (!existsSync(join(site, 'scripts', 'check-data-contracts.ts'))) {
  console.log("Contrat non vérifié : le site n'est pas à côté (../pokedex).")
  process.exit(0)
}
const { success } = Bun.spawnSync([process.execPath, 'run', 'contracts'], {
  cwd: site,
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(success ? 0 : 1)
