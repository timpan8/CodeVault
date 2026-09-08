/** Encoding helpers shared by the re-apply scanner (editor mode) and the leak guard. */

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of counts.values()) {
    const p = c / s.length
    h -= p * Math.log2(p)
  }
  return h
}

export function isMostlyPrintable(s: string): boolean {
  if (s.length < 4) return false
  let printable = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x20 && code < 0x7f) || code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0xa0 && code < 0xfffd)) printable++
  }
  return printable / s.length >= 0.85
}

const B64_RUN = /[A-Za-z0-9+/]{32,}={0,2}|[A-Za-z0-9_-]{32,}/g

export interface Base64Run {
  start: number
  end: number
  run: string
}

export function base64Runs(text: string): Base64Run[] {
  const out: Base64Run[] = []
  for (const m of text.matchAll(B64_RUN)) out.push({ start: m.index, end: m.index + m[0].length, run: m[0] })
  return out
}

const B64_MAP = new Map<string, number>()
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => B64_MAP.set(c, i))
B64_MAP.set('-', 62)
B64_MAP.set('_', 63)

function decodeBytes(run: string): Uint8Array {
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of run) {
    if (ch === '=') break
    const v = B64_MAP.get(ch)
    if (v === undefined) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

const utf8 = new TextDecoder('utf-8', { fatal: false })
const utf16le = new TextDecoder('utf-16le', { fatal: false })

/**
 * Decode a base64-looking run at every char alignment (a value may sit
 * mid-stream) as UTF-8 and UTF-16LE (both byte alignments). Returns the
 * mostly-printable decodings so callers can scan them for real values.
 */
export function decodeBase64Variants(run: string): string[] {
  const out = new Set<string>()
  for (let charOffset = 0; charOffset < 4; charOffset++) {
    const slice = run.slice(charOffset)
    if (slice.length < 8) continue
    const bytes = decodeBytes(slice)
    if (bytes.length === 0) continue
    const candidates = [utf8.decode(bytes), utf16le.decode(bytes), utf16le.decode(bytes.subarray(1))]
    for (const c of candidates) {
      const cleaned = c.replace(/�/g, '')
      if (isMostlyPrintable(cleaned)) out.add(cleaned)
    }
  }
  return [...out]
}

/** Every alternative textual form a real value might take inside code that goes to the AI. */
export function encodedVariants(value: string): string[] {
  const variants = new Set<string>()
  const add = (v: string) => {
    if (v && v !== value) variants.add(v)
  }
  try {
    add(encodeURIComponent(value))
  } catch {
    // unpaired surrogate; skip
  }
  add(value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!))
  add(JSON.stringify(value).slice(1, -1))
  add(value.replace(/[`"$]/g, (c) => '`' + c))
  add(value.replace(/'/g, "''"))
  add(value.replace(/[\\*+?|{[()^$.#\s]/g, (c) => '\\' + c))
  add(base64Utf8(value))
  add(base64Utf16le(value))
  return [...variants]
}

export function base64Utf8(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
}

export function base64Utf16le(value: string): string {
  const bytes = new Uint8Array(value.length * 2)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  return bytesToBase64(bytes)
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64_CHARS[(triple >> 18) & 63]! + B64_CHARS[(triple >> 12) & 63]!
    out += b === undefined ? '=' : B64_CHARS[(triple >> 6) & 63]!
    out += c === undefined ? '=' : B64_CHARS[triple & 63]!
  }
  return out
}
