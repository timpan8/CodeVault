import type { Eol } from './types'
import { SENTINEL_PREAMBLE_RE, SENTINEL_REAL_RE } from './sentinels'

export interface PasteBlock {
  /** Language tag from the markdown fence, or null when the paste had no fences. */
  lang: string | null
  text: string
  lineCount: number
}

export interface NormalizedPaste {
  blocks: PasteBlock[]
  /** Text outside the fences. Never stored; scanned by the guard only. */
  prose: string
  eol: Eol
  hadBom: boolean
  strippedSentinels: Array<'real' | 'preamble'>
  containedRealSentinel: boolean
  looksPartial: boolean
  looksLikeTranscript: boolean
}

const BOM = '\uFEFF'

export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(^|[^\r])\n/g) ?? []).length
  return crlf > lf ? 'crlf' : 'lf'
}

export function applyEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n?/g, '\n')
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}

/** BOM strip, EOL detection, LF normalisation, final-line trailing whitespace trim. */
export function normalizeText(text: string): { text: string; eol: Eol; hadBom: boolean } {
  const hadBom = text.startsWith(BOM)
  const stripped = hadBom ? text.slice(1) : text
  const eol = detectEol(stripped)
  let lf = stripped.replace(/\r\n?/g, '\n')
  // Trim only trailing whitespace on the final line; here-strings are
  // whitespace-sensitive so inner lines are never touched.
  lf = lf.replace(/[ \t]+$/, '')
  return { text: lf, eol, hadBom }
}

export function stripSentinels(text: string): { text: string; stripped: Array<'real' | 'preamble'> } {
  const stripped: Array<'real' | 'preamble'> = []
  const lines = text.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (SENTINEL_REAL_RE.test(line)) {
      stripped.push('real')
      continue
    }
    if (SENTINEL_PREAMBLE_RE.test(line)) {
      stripped.push('preamble')
      continue
    }
    kept.push(line)
  }
  // Drop a single blank line that the preamble left behind at the top.
  while (stripped.length > 0 && kept.length > 0 && kept[0]!.trim() === '') kept.shift()
  return { text: kept.join('\n'), stripped }
}

const ELISION_RE =
  /^\s*(#|\/\/|<#)\s*(\.\.\.|…)?\s*(rest|resten|remaining|existing|unchanged|oförändrad|oförändrat|övrig|other code|same as before|no changes)/im
const ELISION_RE2 = /^\s*#\s*(\.\.\.|…)\s*$/m

export function detectElision(text: string): boolean {
  return ELISION_RE.test(text) || ELISION_RE2.test(text)
}

const CODE_HINT = /[$=(){}|;\\]|-\w+|\bfunction\b|\bparam\b/

/** Heuristic: a paste that is mostly prose is probably a whole chat transcript. */
export function looksLikeTranscript(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 12) return false
  const codeLines = lines.filter((l) => CODE_HINT.test(l)).length
  const preamble = /^(here('s| is)|sure|certainly|här är|absolut|självklart)/i.test(lines[0]!.trim())
  return codeLines / lines.length < 0.3 && preamble
}

const FENCE_RE = /^[ \t]*```([\w+#.-]*)[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm

export function splitFences(lfText: string): { blocks: PasteBlock[]; prose: string } {
  const blocks: PasteBlock[] = []
  const proseParts: string[] = []
  let last = 0
  for (const m of lfText.matchAll(FENCE_RE)) {
    proseParts.push(lfText.slice(last, m.index))
    const body = m[2] ?? ''
    blocks.push({ lang: (m[1] ?? '') || null, text: body.replace(/\n$/, ''), lineCount: body.split('\n').length })
    last = m.index + m[0].length
  }
  proseParts.push(lfText.slice(last))
  return { blocks, prose: proseParts.join('\n').trim() }
}

export function normalizePaste(raw: string): NormalizedPaste {
  const { text, eol, hadBom } = normalizeText(raw)
  const fenced = splitFences(text)
  let blocks: PasteBlock[]
  let prose = ''
  if (fenced.blocks.length > 0) {
    blocks = fenced.blocks
    prose = fenced.prose
  } else {
    blocks = [{ lang: null, text, lineCount: text.split('\n').length }]
  }
  const strippedSentinels: Array<'real' | 'preamble'> = []
  blocks = blocks.map((b) => {
    const s = stripSentinels(b.text)
    strippedSentinels.push(...s.stripped)
    return { ...b, text: s.text, lineCount: s.text.split('\n').length }
  })
  const proseSentinels = stripSentinels(prose)
  strippedSentinels.push(...proseSentinels.stripped)
  const all = blocks.map((b) => b.text).join('\n')
  return {
    blocks,
    prose: proseSentinels.text,
    eol,
    hadBom,
    strippedSentinels,
    containedRealSentinel: strippedSentinels.includes('real'),
    looksPartial: detectElision(all),
    looksLikeTranscript: fenced.blocks.length === 0 && looksLikeTranscript(text),
  }
}

/** 0-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}
