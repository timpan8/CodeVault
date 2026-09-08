/**
 * Diff helpers. Versions are compared on the template level: every slot is
 * one atomic ⟦NAME⟧ token, so a changed example or alias never produces a
 * hunk and no real value can ever appear in a diff document.
 */
import { Text } from '@codemirror/state'
import { Chunk } from '@codemirror/merge'
import { SLOT_CLOSE, SLOT_OPEN } from '@engine/template'
import type { Field, Segment } from '@engine/types'

export const MARKER_RE = /⟦[^⟧]*⟧/g

export function diffDoc(segments: readonly Segment[], fields: ReadonlyMap<string, Field>): string {
  let out = ''
  for (const seg of segments) {
    if (seg.t === 'text') out += seg.s
    else out += `${SLOT_OPEN}${fields.get(seg.fieldId)?.name ?? '?' + seg.fieldId}${SLOT_CLOSE}`
  }
  return out
}

/** Replace ⟦NAME⟧ markers by the field examples (for copying out of the diff). */
export function markersToExamples(text: string, fields: Iterable<Field>): string {
  const byName = new Map<string, Field>()
  for (const f of fields) byName.set(f.name, f)
  return text.replace(MARKER_RE, (m) => {
    const name = m.slice(1, -1)
    return byName.get(name)?.example ?? m
  })
}

export interface DiffStats {
  added: number
  removed: number
  chunks: number
}

function linesIn(t: Text, from: number, to: number): number {
  if (to <= from) return 0
  const end = Math.min(t.length, Math.max(from, to - 1))
  return t.lineAt(end).number - t.lineAt(Math.min(from, t.length)).number + 1
}

/** Upper bound on the LCS table size before falling back to chunk-based counting. */
const LCS_CELL_LIMIT = 4_000_000

/**
 * Line-level added/removed counts. Uses an exact line LCS (after trimming the
 * common prefix and suffix) so an unchanged line between two edits is never
 * counted; very large inputs fall back to the merge chunks, which may merge
 * nearby edits into one hunk.
 */
export function diffStats(a: string, b: string): DiffStats {
  const la = a.split('\n')
  const lb = b.split('\n')
  let start = 0
  while (start < la.length && start < lb.length && la[start] === lb[start]) start++
  let endA = la.length
  let endB = lb.length
  while (endA > start && endB > start && la[endA - 1] === lb[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  const ta = Text.of(la)
  const tb = Text.of(lb)
  const chunks = Chunk.build(ta, tb)
  if (n === 0 && m === 0) return { added: 0, removed: 0, chunks: chunks.length }
  if (n * m > LCS_CELL_LIMIT) {
    let added = 0
    let removed = 0
    for (const c of chunks) {
      removed += linesIn(ta, c.fromA, c.toA)
      added += linesIn(tb, c.fromB, c.toB)
    }
    return { added, removed, chunks: chunks.length }
  }
  // LCS length over the differing middle part.
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = 1; i <= n; i++) {
    const ai = la[start + i - 1]
    for (let j = 1; j <= m; j++) {
      dp[i * w + j] = ai === lb[start + j - 1] ? dp[(i - 1) * w + (j - 1)]! + 1 : Math.max(dp[(i - 1) * w + j]!, dp[i * w + (j - 1)]!)
    }
  }
  const lcs = dp[n * w + m]!
  return { added: m - lcs, removed: n - lcs, chunks: chunks.length }
}

export function formatStats(s: DiffStats): string {
  return `+${s.added} −${s.removed}`
}
