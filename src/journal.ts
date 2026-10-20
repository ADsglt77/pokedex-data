/**
 * Le journal de l'API, dans la sortie du serveur (`docker compose logs -f api`, ou le terminal de
 * `bun run dev`) : une ligne par évènement, alignée, à l'heure de Paris, son niveau en symbole de
 * couleur, son thème, un message court et ses détails en `clé=valeur` :
 *
 *   16/10 14:03:12  ▲  accès       Token refusé                  route="GET /v1/prices"
 *
 * - `accès` : une demande sans token valide (`auth.ts`) ;
 * - `images` : une image que sa source n'a pas donnée (`images.ts`) ;
 * - `serveur` : une erreur imprévue de l'API.
 * Pas les requêtes une à une : seulement ce qui se passe. Ce qu'un client peut provoquer à volonté
 * (un token refusé) : une ligne par minute au plus (`journalOnce`). Jamais un token. Sans couleurs
 * avec `NO_COLOR` (la convention des terminaux).
 */

type JournalTopic = 'accès' | 'images' | 'serveur'

/** À surveiller (un token refusé, une image non copiée), ou en erreur. */
type JournalLevel = 'warn' | 'error'

interface JournalEntry {
  topic: JournalTopic
  level: JournalLevel
  /** Court, une constante, écrite telle quelle : ce qui s'est passé (« Token refusé »). */
  message: string
  /** Le reste, en `clé=valeur` ; une valeur absente n'est pas écrite. */
  details?: Record<string, string | number | undefined>
}

/* Les couleurs du terminal (codes ANSI) */

const COLOR = !process.env.NO_COLOR
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const red = paint('31')
const yellow = paint('33')
const blue = paint('34')
const cyan = paint('36')

const LEVELS: Record<JournalLevel, string> = {
  warn: yellow('▲'),
  error: red('✖'),
}

const TOPICS: Record<JournalTopic, (text: string) => string> = {
  accès: cyan,
  images: blue,
  serveur: red,
}

/** « 16/10 14:03:12 », à l'heure de Paris (le VPS est à l'heure universelle). */
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
  return `${dim(`${key}=`)}${shown}`
}

/** La colonne du message : les détails commencent tous au même endroit. */
const WIDTH = 32

/** Écrit une ligne du journal : le message tel quel, les détails sans danger (`detail`). */
export function journal({ topic, level, message, details = {} }: JournalEntry) {
  const rest = Object.entries(details)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => detail(key, value))
    .join(' ')
  const head = `${dim(TIME.format(new Date()))}  ${LEVELS[level]}  ${TOPICS[topic](topic.padEnd(10))}`
  console.log(`${head}  ${message.padEnd(WIDTH)} ${rest}`.trimEnd())
}

/** Les lignes de `journalOnce` : leur clé, l'heure de la dernière écrite, celles tues depuis. */
const noted = new Map<string, { at: number; silenced: number }>()

/**
 * Écrit une ligne au plus par `key` et par `windowMs` : un afflux de requêtes ne fait pas tourner
 * le journal de Docker. Les lignes tues sont comptées, et dites par la suivante (`tues=…`).
 */
export function journalOnce(key: string, entry: JournalEntry, windowMs: number) {
  const now = Date.now()
  const known = noted.get(key)
  if (known && now - known.at < windowMs) {
    known.silenced++
    return
  }
  noted.set(key, { at: now, silenced: 0 })
  journal({ ...entry, details: { ...entry.details, tues: known?.silenced || undefined } })
}

/** Le démarrage du serveur : son adresse, ses clients, le mode, la version de Bun. */
export function banner({ api, clients }: { api: string; clients: string[] }) {
  const mode = process.env.NODE_ENV === 'production' ? 'production' : 'développement'
  console.log(
    [
      '',
      `  ${bold('Pokédex · données')} ${dim('· l’API privée')}`,
      `  ${dim('─'.repeat(38))}`,
      `  ${dim('API      ')}${api}`,
      `  ${dim('Clients  ')}${clients.length ? clients.join(', ') : yellow('aucun : API_TOKENS manque')}`,
      `  ${dim(`${mode} · Bun ${Bun.version} · prêt en ${Math.round(performance.now())} ms`)}`,
      '',
    ].join('\n'),
  )
}
