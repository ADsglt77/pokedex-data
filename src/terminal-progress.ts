/** Une progression compacte dans un terminal interactif, et quelques jalons dans les logs. */

const BAR_WIDTH = 24
const LOG_INTERVAL = 5 * 60_000
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const interactive = Boolean(process.stdout.isTTY)
const color = interactive && !process.env.NO_COLOR

const paint = (code: number, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text)

export const strong = (text: string) => paint(1, text)
export const muted = (text: string) => paint(90, text)
export const success = (text: string) => paint(32, text)
export const failure = (text: string) => paint(31, text)

/**
 * Un nombre et ce qu'il compte, accordé : `plural(1, 'carte lue', 'cartes lues')` → « 1 carte
 * lue » (0 et 1 au singulier).
 */
export const plural = (count: number, one: string, many: string) =>
  `${count} ${count > 1 ? many : one}`

/** Une durée lisible, sans précision inutile. */
export function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours) return `${hours} h ${minutes.toString().padStart(2, '0')} min`
  if (minutes) return `${minutes} min ${rest.toString().padStart(2, '0')} s`
  return `${rest} s`
}

/**
 * Met à jour une seule ligne dans un terminal. Redirigée vers Docker ou un fichier, la progression
 * écrit au plus un jalon tous les 5 % ou toutes les 5 minutes.
 */
export class TerminalProgress {
  private readonly label: string
  private readonly total: number
  private done = 0
  private frame = 0
  private lastPercent = -1
  private lastLog = 0
  private stopped = false
  private readonly started = Date.now()

  constructor(label: string, total: number) {
    this.label = label
    this.total = total
    this.render(true)
  }

  update(done: number) {
    if (this.stopped) return
    this.done = Math.min(Math.max(done, 0), this.total)
    this.frame++
    this.render(false)
  }

  /** Efface provisoirement la barre avant un avertissement. */
  clear() {
    if (interactive && !this.stopped) process.stdout.write('\r\x1b[2K')
  }

  /** Réaffiche la barre après un avertissement. */
  redraw() {
    if (!this.stopped) this.render(true)
  }

  finish() {
    if (this.stopped) return
    this.done = this.total
    this.render(true)
    if (interactive) process.stdout.write('\n')
    this.stopped = true
  }

  /** Retire une barre dont le traitement vient d’échouer. */
  stop() {
    if (this.stopped) return
    this.clear()
    this.stopped = true
  }

  private render(force: boolean) {
    const now = Date.now()
    const ratio = this.total ? this.done / this.total : 1
    const percent = Math.floor(ratio * 100)
    if (!interactive) {
      const milestone = Math.floor(percent / 5)
      if (!force && milestone === this.lastPercent && now - this.lastLog < LOG_INTERVAL) return
      this.lastPercent = milestone
      this.lastLog = now
    }

    const filled = Math.round(ratio * BAR_WIDTH)
    const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`
    const elapsed = now - this.started
    const remaining = this.done ? (elapsed / this.done) * (this.total - this.done) : 0
    const estimate =
      this.done < this.total && remaining > 1000 ? ` · reste ~${duration(remaining)}` : ''
    const line =
      `  ${paint(36, SPINNER[this.frame % SPINNER.length]!)} ${this.label} ` +
      `${paint(36, bar)} ${String(percent).padStart(3)} % ` +
      `${this.done.toLocaleString('fr-FR')}/${this.total.toLocaleString('fr-FR')}` +
      ` · ${duration(elapsed)}${estimate}`

    if (interactive) process.stdout.write(`\r\x1b[2K${line}`)
    else console.log(line)
  }
}
