import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reapply } from '@engine/reapply'
import { createField } from '@engine/fields'
import type { Field, FieldKind } from '@engine/types'
import { initialRows } from '@ui/review'
import { findingIndex, findingsOf, mergeSpans, redactSpans, stepFinding, type Finding } from '@ui/findings'

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url))
const NOW = '2026-01-01T00:00:00.000Z'

const row = (id: string, start: number, end: number, line = 0) =>
  ({
    id,
    kind: 'slot' as const,
    proposal: { start, end, line, fieldId: 'f', quote: 'sq' as const, conf: 1, status: 'auto' as const, why: 'literal' as const, literal: '', warnings: [] },
    decision: 'accept' as const,
    fieldId: 'f',
  })

describe('redactSpans', () => {
  it('keeps the length, the newlines and the quotes around the span', () => {
    const text = "$p = 'Sommar2024!'\n$s = 'dc01'\n"
    // The span is the token content, so the quotes sit outside it.
    const out = redactSpans(text, [{ from: 6, to: 17 }])
    expect(out).toHaveLength(text.length)
    expect(out).toBe("$p = '•••••••••••'\n$s = 'dc01'\n")
    expect(out.split('\n')).toHaveLength(text.split('\n').length)
    expect(out).not.toContain('Sommar2024!')
  })

  it('a multi-line span keeps every line break, so later line numbers do not shift', () => {
    const text = 'a\n@(\n  one\n  two\n)\nlast\n'
    const from = text.indexOf('@(')
    const to = text.indexOf(')') + 1
    const out = redactSpans(text, [{ from, to }])
    expect(out).toHaveLength(text.length)
    expect(out.split('\n')).toHaveLength(text.split('\n').length)
    expect(out.split('\n').indexOf('last')).toBe(text.split('\n').indexOf('last'))
    expect(out).not.toContain('one')
  })

  it('is idempotent and leaves text alone with no spans', () => {
    const text = "$p = 'secret'"
    const once = redactSpans(text, [{ from: 6, to: 12 }])
    expect(redactSpans(once, [{ from: 6, to: 12 }])).toBe(once)
    expect(redactSpans(text, [])).toBe(text)
  })

  it('clamps spans that run past the end', () => {
    expect(redactSpans('abc', [{ from: 1, to: 99 }])).toBe('a••')
    expect(redactSpans('abc', [{ from: 5, to: 9 }])).toBe('abc')
  })
})

describe('mergeSpans', () => {
  it('joins overlapping and touching spans, drops empty ones', () => {
    expect(mergeSpans([{ from: 5, to: 9 }, { from: 0, to: 3 }])).toEqual([{ from: 0, to: 3 }, { from: 5, to: 9 }])
    expect(mergeSpans([{ from: 0, to: 5 }, { from: 3, to: 9 }])).toEqual([{ from: 0, to: 9 }])
    expect(mergeSpans([{ from: 0, to: 5 }, { from: 5, to: 9 }])).toEqual([{ from: 0, to: 9 }])
    expect(mergeSpans([{ from: 4, to: 4 }])).toEqual([])
  })
})

describe('findingsOf', () => {
  const never = () => false

  it('returns document order, not the order of the rows', () => {
    const rows = [row('a', 40, 45), row('b', 5, 9), row('c', 20, 24)]
    expect(findingsOf(rows, never, 100).map((f) => f.id)).toEqual(['b', 'c', 'a'])
  })

  it('drops zero-length spans, clamps to the text and skips overlaps', () => {
    const rows = [row('a', 5, 5), row('b', 10, 14), row('c', 12, 20)]
    expect(findingsOf(rows, never, 100).map((f) => f.id)).toEqual(['b'])
    expect(findingsOf([row('a', 2, 99)], never, 6)).toEqual([{ id: 'a', from: 2, to: 6, line: 0, status: 'auto', masked: false }])
  })

  it('a row with no span at all is not steppable', () => {
    const rows = [{ id: 'm', kind: 'slot' as const, decision: 'pending' as const, fieldId: 'f' }]
    expect(findingsOf(rows, never, 100)).toEqual([])
  })

  it('a rejected row keeps its span but reads as rejected', () => {
    const rows = [{ ...row('a', 1, 5), decision: 'reject' as const }]
    expect(findingsOf(rows, never, 100)[0]!.status).toBe('rejected')
  })
})

describe('stepFinding', () => {
  const fs = [
    { id: 'a', from: 0, to: 1, line: 0, status: 'auto', masked: false },
    { id: 'b', from: 2, to: 3, line: 0, status: 'auto', masked: false },
    { id: 'c', from: 4, to: 5, line: 0, status: 'auto', masked: false },
  ] satisfies Finding[]

  it('wraps both ways and starts at an end when nothing is active', () => {
    expect(stepFinding(fs, null, 1)).toBe('a')
    expect(stepFinding(fs, null, -1)).toBe('c')
    expect(stepFinding(fs, 'b', 1)).toBe('c')
    expect(stepFinding(fs, 'c', 1)).toBe('a')
    expect(stepFinding(fs, 'a', -1)).toBe('c')
    expect(stepFinding([], 'a', 1)).toBe(null)
    // An id from a previous analysis is treated as no selection.
    expect(stepFinding(fs, 'gone', 1)).toBe('a')
  })

  it('findingIndex is 1-based, 0 for nothing active', () => {
    expect(findingIndex(fs, 'b')).toBe(2)
    expect(findingIndex(fs, null)).toBe(0)
    expect(findingIndex(fs, 'gone')).toBe(0)
  })
})

/**
 * The point of the whole module: a paste imported from the editor carries real
 * values, and the code view must show the identifying ones while the secrets
 * never enter the document at all.
 */
describe('redaction over a real editor paste', () => {
  it('hides the password and keeps the server name', () => {
    const dir = join(FIXTURES, 'editor/unregistered-server')
    const paste = readFileSync(join(dir, 'paste.txt'), 'utf8')
    const fixture = JSON.parse(readFileSync(join(dir, 'fields.json'), 'utf8')) as Array<{
      id: string
      name: string
      kind: FieldKind
      example: string
      nameAnchors?: string[]
      real?: string
    }>

    const fields: Field[] = []
    const real = new Map<string, string>()
    for (const f of fixture) {
      fields.push({ ...createField({ id: f.id, name: f.name, kind: f.kind, example: f.example, now: NOW }), nameAnchors: f.nameAnchors ?? [], aliases: [] })
      if (f.real !== undefined) real.set(f.id, f.real)
    }

    const result = reapply({ text: paste, fields, real, mode: 'editor' })
    const rows = initialRows(result)
    const byId = new Map(fields.map((f) => [f.id, f]))
    const isMasked = (r: (typeof rows)[number]) => {
      const field = r.fieldId ? byId.get(r.fieldId) : undefined
      const kind = field?.kind ?? r.proposal?.kindGuess ?? r.unknown?.kindGuess
      return kind === 'password' || kind === 'apiKey' || kind === 'blob'
    }

    const findings = findingsOf(rows, isMasked, paste.length)
    const doc = redactSpans(paste, findings.filter((f) => f.masked))

    expect(doc).toHaveLength(paste.length)
    expect(doc.split('\n')).toHaveLength(paste.split('\n').length)
    // The secret is gone from the document itself, not merely hidden in the view.
    expect(doc).not.toContain('Sommar2024!')
    // Identifying values stay readable, registered ('svc-adsync') or not
    // ('dc02...', which this fixture leaves unknown on purpose).
    expect(doc).toContain('svc-adsync')
    expect(doc).toContain('dc02.corp.contoso.se')
    // Every value the paste carries that is neither is untouched.
    for (const f of fixture) {
      if (f.real === undefined || !paste.includes(f.real)) continue
      const secret = f.kind === 'password' || f.kind === 'apiKey' || f.kind === 'blob'
      if (secret) expect(doc, `${f.name} must not reach the document`).not.toContain(f.real)
      else expect(doc, `${f.name} is identifying, not secret`).toContain(f.real)
    }
    // At least one secret was actually present to redact, or this proves nothing.
    expect(findings.some((f) => f.masked)).toBe(true)
  })
})
