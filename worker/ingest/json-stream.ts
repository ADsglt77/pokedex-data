/**
 * Un gros document JSON lu en flux : `{ …, "<key>": [ {…}, {…} ], … }`, chaque objet du tableau
 * `key` rendu un à un (`onItem`), le reste du document gardé en texte (`rest`, sans le tableau).
 * Le guide des prix et la liste des produits de Cardmarket (16 et 14 Mo) ne tiendraient pas lus
 * d'un coup : leurs objets prendraient plus que les 128 Mo du Worker. Les objets du tableau sont
 * plats ou non ; un texte peut contenir accolades et guillemets échappés. Un document coupé avant
 * la fin du tableau (une connexion rompue) est refusé : lu jusque-là, il passerait pour complet.
 * Un objet du tableau, ou le reste du document, de plus d'un million de caractères (environ 1 Mo)
 * n'est pas celui d'un fichier de Cardmarket (quelques centaines d'octets) : une erreur, plutôt
 * que la mémoire du Worker épuisée.
 */

/** Au-delà, un objet en cours ou le reste du document : une erreur (en caractères). */
const MAX_TEXT = 1_000_000

export async function streamArray<T>(
  body: ReadableStream<Uint8Array>,
  key: string,
  onItem: (item: T) => void,
) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  const opening = new RegExp(`"${key}"\\s*:\\s*\\[`)
  let rest = ''
  /** Le texte reçu, pas encore lu : avant le tableau, puis son objet en cours. */
  let pending = ''
  let state: 'before' | 'inside' | 'after' = 'before'
  /** Trop long : la lecture s'arrête là. */
  const tooLong = async () => {
    await reader.cancel()
    return new Error(`${key} : plus d'un million de caractères d'un tenant (document inattendu ?)`)
  }
  /** L'objet en cours (pas encore fini) et le reste du document, bornés. */
  const bounded = async () => {
    if (pending.length > MAX_TEXT || rest.length > MAX_TEXT) throw await tooLong()
  }
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    if (state === 'after') {
      rest += next.value
      await bounded()
      continue
    }
    pending += next.value
    if (state === 'before') {
      const found = opening.exec(pending)
      if (!found) {
        await bounded()
        continue
      }
      rest += pending.slice(0, found.index)
      pending = pending.slice(found.index + found[0].length)
      state = 'inside'
    }
    // Lu depuis le début de l'objet en cours : l'objet en cours commence à `start` (-1 : entre
    // deux objets).
    let start = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = 0; index < pending.length; index++) {
      const char = pending[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') {
        if (depth++ === 0) start = index
      } else if (char === '}') {
        if (--depth === 0) {
          // Fini dans ce morceau, il n'a pas été vu en cours : borné ici aussi.
          if (index + 1 - start > MAX_TEXT) throw await tooLong()
          onItem(JSON.parse(pending.slice(start, index + 1)) as T)
          start = -1
        }
      } else if (char === ']' && depth === 0) {
        state = 'after'
        rest += pending.slice(index + 1)
        break
      }
    }
    // Ce qui reste à lire : l'objet en cours, relu depuis son début à la prochaine réception.
    pending = state === 'inside' && start >= 0 ? pending.slice(start) : ''
    await bounded()
  }
  // Sans la fin de son tableau, le document est coupé (ou n'a pas ce tableau) : ce qui en a été lu
  // n'est pas le document entier.
  if (state !== 'after') throw new Error(`${key} : la fin du tableau manque (document tronqué ?)`)
  return rest
}
