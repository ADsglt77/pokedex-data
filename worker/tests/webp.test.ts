/**
 * Les métadonnées retirées d'un WebP copié (`worker/ingest/webp.ts`) : une erreur ici abîmerait
 * toutes les images copiées. Un WebP réel (6 × 3 px, transparent à moitié, fait par Chrome :
 * `VP8X`, profil `ICCP`, `ALPH`, `VP8 `) auquel on ajoute des blocs `EXIF` et `XMP ` en ressort
 * octet pour octet tel qu'il était, image, transparence et profil compris ; un bloc de taille
 * impaire part avec son octet de bourrage ; un fichier sans métadonnées, un autre format ou un WebP
 * mal formé sont rendus tels quels. Et `mirror` écrit dans R2 le WebP sans elles.
 */

import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { withoutMetadata } from '../ingest/webp'

// `politeFetch` sans ses 100 ms d'attente ; `images.ts`, déjà chargé par l'entrée du Worker,
// rechargé pour le prendre.
vi.mock(import('../ingest/net'), async (original) => ({
  ...(await original()),
  politeFetch: (url, init) => fetch(url, init),
}))
vi.resetModules()
const { mirror } = await import('../ingest/images')

/** Le WebP fait par Chrome (`canvas.toDataURL('image/webp')`), 604 octets. */
const LOGO = Uint8Array.from(
  atob(
    [
      'UklGRlQCAABXRUJQVlA4WAoAAAAwAAAABQAAAgAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAA',
      'AABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAA',
      'ABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAA',
      'AAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAA',
      'AAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAA',
      'AABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZBTFBIDAAAAAEP',
      '8MD/iIhQnIj+B1ZQOCBSAAAAcAMAnQEqBgADAADAEiWoAnS6AUAD8AK0A/QDLAP0ABbszTMAAP7+LfVXMGVPrv3/2YdLixH/',
      '7fD/9MOlxYj/7fD/+e8o0Mr7A/tZDOM9OgAAAA==',
    ].join(''),
  ),
  (char) => char.charCodeAt(0),
)

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0))

/** Un bloc RIFF : son nom, sa taille, son contenu, et l'octet de bourrage d'une taille impaire. */
function chunk(id: string, payload: Uint8Array) {
  const bytes = new Uint8Array(8 + payload.length + (payload.length % 2))
  bytes.set(ascii(id))
  new DataView(bytes.buffer).setUint32(4, payload.length, true)
  bytes.set(payload, 8)
  return bytes
}

/** Les blocs d'un WebP, dans l'ordre : [nom, taille, octets]. */
function chunksOf(webp: Uint8Array) {
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength)
  const found: [string, number, Uint8Array][] = []
  for (let at = 12; at + 8 <= webp.length;) {
    const size = view.getUint32(at + 4, true)
    const next = at + 8 + size + (size % 2)
    found.push([String.fromCharCode(...webp.subarray(at, at + 4)), size, webp.subarray(at, next)])
    at = next
  }
  return found
}

/** Un WebP de ces blocs : l'en-tête RIFF et sa taille. */
function webpOf(chunks: Uint8Array[]) {
  const length = 12 + chunks.reduce((total, bytes) => total + bytes.length, 0)
  const bytes = new Uint8Array(length)
  bytes.set(ascii('RIFF'))
  new DataView(bytes.buffer).setUint32(4, length - 8, true)
  bytes.set(ascii('WEBP'), 8)
  let at = 12
  for (const part of chunks) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

/**
 * Le logo (`logo`, celui de Chrome par défaut) avec des métadonnées, comme ceux de la source :
 * `EXIF` (7 octets, bourré d'un octet) après le profil, `XMP ` à la fin, et leurs drapeaux (`E`,
 * `X`) dans le `VP8X`.
 */
function logoWithMetadata(logo = LOGO) {
  const [vp8x, iccp, alph, vp8] = chunksOf(logo).map(([, , bytes]) => bytes.slice())
  vp8x![8] = vp8x![8]! | 0x08 | 0x04
  const exif = chunk('EXIF', ascii('Exif\0\0!'))
  const xmp = chunk('XMP ', ascii('<x:xmpmeta>'.repeat(1000)))
  return webpOf([vp8x!, iccp!, exif, alph!, vp8!, xmp])
}

describe('withoutMetadata', () => {
  test('le logo de Chrome : quatre blocs, son profil, sa transparence, aucune métadonnée', () => {
    expect(chunksOf(LOGO).map(([id, size]) => [id, size])).toEqual([
      ['VP8X', 10],
      ['ICCP', 456],
      ['ALPH', 12],
      ['VP8 ', 82],
    ])
    // ICC (I) et transparence (L), ni EXIF ni XMP.
    expect(LOGO[20]).toBe(0x20 | 0x10)
  })

  test('ses blocs EXIF et XMP retirés, leurs drapeaux effacés : le logo de Chrome, octet pour octet', () => {
    const withMetadata = logoWithMetadata()
    expect(chunksOf(withMetadata).map(([id]) => id)).toEqual([
      'VP8X',
      'ICCP',
      'EXIF',
      'ALPH',
      'VP8 ',
      'XMP ',
    ])
    expect(withMetadata.length).toBeGreaterThan(LOGO.length + 11_000)
    expect(withoutMetadata(withMetadata)).toEqual(LOGO)
  })

  test('les drapeaux effacés seulement dans le VP8X : le filtre de la transparence (ALPH) gardé', () => {
    // Le premier octet d'`ALPH` porte, aux mêmes bits que `E` et `X`, le filtre de la
    // transparence (0x0D : « gradient », celui d'un vrai logo de la source).
    const filtered = LOGO.slice()
    const alph = chunksOf(filtered).find(([id]) => id === 'ALPH')!
    alph[2][8] = 0x0d
    expect(withoutMetadata(logoWithMetadata(filtered))).toEqual(filtered)
  })

  test('sans métadonnées, ou pas un WebP : rendu tel quel, sans copie', () => {
    expect(withoutMetadata(LOGO)).toBe(LOGO)
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    expect(withoutMetadata(png)).toBe(png)
    const riffNotWebp = webpOf([chunk('XMP ', ascii('x'))]).fill(0x41, 8, 12)
    expect(withoutMetadata(riffNotWebp)).toBe(riffNotWebp)
    const tooShort = ascii('RIFF')
    expect(withoutMetadata(tooShort)).toBe(tooShort)
  })

  test('un WebP mal formé : rendu tel quel, rien n’est coupé', () => {
    const withMetadata = logoWithMetadata()
    // Coupé avant la fin que dit son en-tête.
    const truncated = withMetadata.slice(0, -3)
    expect(withoutMetadata(truncated)).toBe(truncated)
    // Un bloc qui annonce plus d'octets qu'il n'en reste.
    const overflowing = withMetadata.slice()
    const last = chunksOf(overflowing).at(-1)!
    new DataView(overflowing.buffer).setUint32(
      overflowing.length - last[2].length + 4,
      last[1] + 100,
      true,
    )
    expect(withoutMetadata(overflowing)).toBe(overflowing)
    // Des octets après le dernier bloc, que l'en-tête RIFF compte.
    const trailing = webpOf([...chunksOf(withMetadata).map(([, , bytes]) => bytes), ascii('ABC')])
    expect(withoutMetadata(trailing)).toBe(trailing)
  })
})

describe('mirror : le WebP écrit dans R2 sans ses métadonnées', () => {
  afterEach(() => vi.restoreAllMocks())

  test('le logo copié est celui de Chrome, son type gardé', async () => {
    await env.FILES.delete('images/sets/fr/SVP-md.webp')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(logoWithMetadata(), { headers: { 'Content-Type': 'image/webp' } }),
    )
    expect(await mirror('/images/sets/fr/SVP-md.webp')).toBe(true)
    const object = await env.FILES.get('images/sets/fr/SVP-md.webp')
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(LOGO)
    expect(object!.httpMetadata?.contentType).toBe('image/webp')
  })
})
