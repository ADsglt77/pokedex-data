/**
 * Les métadonnées d'un WebP copié (`mirror`, `images.ts`) : certaines images de la source portent
 * un bloc XMP bien plus lourd que l'image (un logo de 214 × 99 px : 1,5 Mo, dont 99,6 % de XMP).
 * Les blocs `XMP ` et `EXIF` sont retirés avant l'écriture dans R2, leurs drapeaux effacés du
 * `VP8X` et la taille RIFF réécrite ; tout le reste (l'image, sa transparence, son profil de
 * couleur `ICCP`, une animation) est gardé octet pour octet. Seulement un WebP : tout autre
 * fichier, ou un WebP mal formé (un bloc qui déborde, des octets en trop), est rendu tel quel
 * (décision de l'utilisateur, novembre 2026).
 */

/** Les blocs retirés. */
const METADATA = new Set(['XMP ', 'EXIF'])

/** Les drapeaux du `VP8X` (son premier octet) qui annoncent ces blocs : EXIF (`E`) et XMP (`X`). */
const METADATA_FLAGS = 0x08 | 0x04

const fourCC = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)

/**
 * `bytes` sans ses blocs `XMP ` et `EXIF` ; `bytes` lui-même s'il n'en a pas, ou n'est pas un WebP
 * bien formé.
 */
export function withoutMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12 || fourCC(bytes, 0) !== 'RIFF' || fourCC(bytes, 8) !== 'WEBP') return bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = 8 + view.getUint32(4, true)
  if (end > bytes.length) return bytes
  // Les blocs gardés : [début, fin) de chacun, octet de bourrage compris (une taille impaire).
  const kept: [number, number][] = []
  let dropped = false
  let offset = 12
  while (offset + 8 <= end) {
    const size = view.getUint32(offset + 4, true)
    const next = offset + 8 + size + (size % 2)
    if (METADATA.has(fourCC(bytes, offset))) dropped = true
    else kept.push([offset, next])
    offset = next
  }
  // Les blocs doivent finir là où l'en-tête RIFF le dit : un bloc qui déborde, ou des octets en
  // trop, et le fichier est rendu tel quel.
  if (!dropped || offset !== end) return bytes
  const length = 12 + kept.reduce((total, [from, to]) => total + to - from, 0)
  const out = new Uint8Array(length)
  out.set(bytes.subarray(0, 12))
  new DataView(out.buffer).setUint32(4, length - 8, true)
  let at = 12
  for (const [from, to] of kept) {
    out.set(bytes.subarray(from, to), at)
    if (fourCC(bytes, from) === 'VP8X') out[at + 8] = out[at + 8]! & ~METADATA_FLAGS
    at += to - from
  }
  return out
}
