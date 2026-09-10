/**
 * Turning review rows into something a code view can paint. Pure, so it can be
 * tested: vitest runs in a node environment, which rules out component tests.
 *
 * The redaction here is what keeps invariant 6 in an editor-mode paste. Hiding
 * a secret with a replace decoration would not do — the text stays in the
 * document, so `sliceDoc()` and `state.toJSON()` still hand it over. The span is
 * rewritten before the document exists instead, length and newlines preserved so
 * every offset, gutter line number and surrounding quote still lines up.
 */
import type { ReviewRow } from './review'

export type FindingStatus = 'auto' | 'confirm' | 'candidate' | 'unknown' | 'rejected'

export interface Finding {
  /** ReviewRow.id, e.g. 's3' or 'u1'. */
  id: string
  from: number
  to: number
  /** 0-based, as the engine reports it. */
  line: number
  status: FindingStatus
  /** The document is redacted over this span. */
  masked: boolean
}

export interface Span {
  from: number
  to: number
}

function statusOf(row: ReviewRow): FindingStatus {
  if (row.decision === 'reject') return 'rejected'
  if (row.kind === 'unknown') return 'unknown'
  return row.proposal!.status
}

/**
 * Findings in document order. Built from rows rather than the ReapplyResult:
 * trimPathRow rewrites a proposal's end when a row is linked to a path field,
 * and the highlight has to shrink with it.
 *
 * Rows without a span — a field that went missing — are not steppable and are
 * left out. Overlaps are dropped rather than merged: CodeMirror throws on
 * overlapping marks, and the earlier row is the one the engine preferred.
 */
export function findingsOf(rows: readonly ReviewRow[], isMasked: (row: ReviewRow) => boolean, textLength: number): Finding[] {
  const out: Finding[] = []
  for (const row of rows) {
    const src = row.proposal ?? row.unknown
    if (!src) continue
    const from = Math.max(0, Math.min(src.start, textLength))
    const to = Math.max(0, Math.min(src.end, textLength))
    if (to <= from) continue
    out.push({ id: row.id, from, to, line: src.line, status: statusOf(row), masked: isMasked(row) })
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to)
  const kept: Finding[] = []
  for (const f of out) {
    const prev = kept[kept.length - 1]
    if (prev && f.from < prev.to) continue
    kept.push(f)
  }
  return kept
}

/** Overlapping and touching spans joined, so a span is never redacted twice. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].filter((s) => s.to > s.from).sort((a, b) => a.from - b.from || a.to - b.to)
  const out: Span[] = []
  for (const s of sorted) {
    const prev = out[out.length - 1]
    if (prev && s.from <= prev.to) prev.to = Math.max(prev.to, s.to)
    else out.push({ from: s.from, to: s.to })
  }
  return out
}

const BULLET = '•'

/**
 * Every span replaced by bullets, one per character, with line breaks left
 * alone. Keeping the length matters because every other finding indexes the
 * same string; keeping the newlines matters because a table-block span covers
 * several lines and collapsing it would shift every "rad N" after it.
 */
export function redactSpans(text: string, spans: readonly Span[]): string {
  const merged = mergeSpans(spans)
  if (merged.length === 0) return text
  let out = ''
  let at = 0
  for (const s of merged) {
    const from = Math.max(at, Math.min(s.from, text.length))
    const to = Math.max(from, Math.min(s.to, text.length))
    out += text.slice(at, from)
    for (const ch of text.slice(from, to)) out += ch === '\n' || ch === '\r' ? ch : BULLET
    at = to
  }
  return out + text.slice(at)
}

/** The next or previous finding, wrapping. A null activeId starts at the first. */
export function stepFinding(findings: readonly Finding[], activeId: string | null, delta: 1 | -1): string | null {
  if (findings.length === 0) return null
  const at = activeId === null ? -1 : findings.findIndex((f) => f.id === activeId)
  if (at < 0) return (delta === 1 ? findings[0] : findings[findings.length - 1])!.id
  const next = (at + delta + findings.length) % findings.length
  return findings[next]!.id
}

/** 1-based position of `activeId` for the counter, or 0 when nothing is active. */
export function findingIndex(findings: readonly Finding[], activeId: string | null): number {
  if (activeId === null) return 0
  const at = findings.findIndex((f) => f.id === activeId)
  return at < 0 ? 0 : at + 1
}
