/**
 * Le journal de l'API, dans la sortie du Worker (le terminal de `bun run dev` ; en ligne, les
 * journaux du Worker chez Cloudflare) : une ligne par évènement, alignée, à l'heure de Paris, son
 * niveau en symbole, son thème, un message court et ses détails en `clé=valeur` :
 *
 *   16/10 14:03:12  ▲  accès       Débit dépassé                    route="GET /v1/prices"
 *
 * - `accès` : une demande sans token valide (`auth.ts`), ou au-delà des limites de l'entrée
 *   d'Internet (`limits.ts`) ;
 * - `serveur` : une erreur imprévue de l'API ;
 * - `tâches` : les tâches d'ingestion (`ingest/`) : un passage réussi ou en échec (sa cause), ce
 *   qu'il a lu et écrit, une page ou une image en erreur, une tâche déjà en cours.
 * Pas les requêtes une à une : seulement ce qui se passe. Ce qu'un client peut provoquer à volonté
 * (un token refusé) : une ligne par minute au plus (`journalOnce`, pour chaque exemplaire du
 * Worker). Jamais un token. Sans couleurs : les journaux de Cloudflare les montreraient en codes.
 */

import { MINUTE } from '@/lib/time'

type JournalTopic = 'accès' | 'serveur' | 'tâches'

/** Réussi, simple information, à surveiller (un token refusé), ou en erreur. */
type JournalLevel = 'ok' | 'info' | 'warn' | 'error'

interface JournalEntry {
  topic: JournalTopic
  level: JournalLevel
  /** Court, une constante, écrite telle quelle : ce qui s'est passé (« Token refusé »). */
  message: string
  /** Le reste, en `clé=valeur` ; une valeur absente n'est pas écrite. */
  details?: Record<string, string | number | undefined>
}

const LEVELS: Record<JournalLevel, string> = { ok: '✔', info: '•', warn: '▲', error: '✖' }

/** « 16/10 14:03:12 », à l'heure de Paris (Cloudflare est à l'heure universelle). */
const TIME = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** La longueur d'une valeur écrite, au plus. */
const MAX_VALUE = 200

/** Coupé au-delà de `MAX_VALUE` caractères (« … » à la fin). */
const cut = (text: string) => (text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text)

/**
 * Les caractères de contrôle (C0, DEL, C1 dont le CSI `\x9b`) en `\u00xx` : dans un texte venu
 * d'ailleurs, un retour à la ligne écrirait une fausse ligne du journal, un échappement ANSI
 * piloterait le terminal.
 */
const escapeControls = (text: string) =>
  text.replace(/\p{Cc}/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

/**
 * `route="GET /v1/prices"` : entre guillemets, échappée comme en JSON, dès qu'il y a une espace, un
 * guillemet, un `=` ou un caractère de contrôle ; coupée au-delà de `MAX_VALUE` caractères.
 */
const detail = (key: string, value: string | number) => {
  const text = cut(String(value))
  const shown = /[\s="\p{Cc}]/u.test(text) ? escapeControls(JSON.stringify(text)) : text
  return `${key}=${shown}`
}

/** La colonne du message : les détails commencent tous au même endroit. */
const WIDTH = 32

/** Écrit une ligne du journal : le message tel quel, les détails sans danger (`detail`). */
export function journal({ topic, level, message, details = {} }: JournalEntry) {
  const rest = Object.entries(details)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => detail(key, value))
    .join(' ')
  const head = `${TIME.format(new Date())}  ${LEVELS[level]}  ${topic.padEnd(10)}`
  console.log(`${head}  ${message.padEnd(WIDTH)} ${rest}`.trimEnd())
}

/** Les lignes de `journalOnce` : leur clé, l'heure de la dernière écrite, celles tues depuis. */
const noted = new Map<string, { at: number; silenced: number }>()

/**
 * Écrit une ligne au plus par `key` et par minute : un afflux de requêtes ne noie pas le journal.
 * Les lignes tues sont comptées, et dites par la suivante (`tues=…`).
 */
export function journalOnce(key: string, entry: JournalEntry) {
  const now = Date.now()
  const known = noted.get(key)
  if (known && now - known.at < MINUTE) {
    known.silenced++
    return
  }
  noted.set(key, { at: now, silenced: 0 })
  journal({ ...entry, details: { ...entry.details, tues: known?.silenced || undefined } })
}

/** « 1 série », « 3 séries » : le nombre et le mot qui s'accorde. */
export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

/** La raison d'un échec : le message d'une erreur. */
export const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
