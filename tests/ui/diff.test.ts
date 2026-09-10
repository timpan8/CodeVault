import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { diffDoc, diffStats, formatStats, markersToExamples } from '@ui/diff'
import { buildVersion, directoryPart, initialRows, trimPathRow } from '@ui/review'
import { reapply } from '@engine/reapply'
import type { Field } from '@engine/types'
import { createField } from '@engine/fields'
import { parseTemplate } from '@engine/template'
import { VaultStore } from '@vault/store'
import { VaultSession } from '@vault/session'

const NOW = '2026-01-01T00:00:00.000Z'

describe('diff helpers', () => {
  const user = createField({ id: 'u', name: 'SVC_USER', kind: 'username', example: 'svc-example01', now: NOW })
  const fields = new Map([[user.id, user]])

  it('renders slots as atomic name markers', () => {
    expect(diffDoc(parseTemplate("$u = '⟦f:u|sq⟧'"), fields)).toBe("$u = '⟦SVC_USER⟧'")
    expect(markersToExamples("$u = '⟦SVC_USER⟧'", fields.values())).toBe("$u = 'svc-example01'")
  })

  it('counts added and removed lines', () => {
    const a = 'line1\nline2\nline3'
    const b = 'line1\nline2 changed\nline3\nline4'
    const s = diffStats(a, b)
    expect(s.added).toBe(2)
    expect(s.removed).toBe(1)
    expect(formatStats(s)).toBe('+2 −1')
    expect(diffStats(a, a)).toEqual({ added: 0, removed: 0, chunks: 0 })
  })
})

describe('path helpers', () => {
  it('directoryPart strips file names and trailing separators', () => {
    expect(directoryPart('C:\\Temp\\AdSync\\users.csv')).toBe('C:\\Temp\\AdSync')
    expect(directoryPart('C:\\Temp\\AdSync\\')).toBe('C:\\Temp\\AdSync')
    expect(directoryPart('C:\\Temp\\AdSync')).toBe('C:\\Temp\\AdSync')
    expect(directoryPart('\\\\fs01\\share\\logs\\run.log')).toBe('\\\\fs01\\share\\logs')
  })

  it('trimPathRow shrinks the span to the directory and keeps the file name as suffix', () => {
    const row = trimPathRow({
      id: 'r',
      kind: 'slot',
      decision: 'accept',
      fieldId: 'p',
      proposal: { start: 10, end: 35, line: 0, fieldId: null, quote: 'sq', conf: 0.35, status: 'candidate', why: 'detector', literal: 'C:\\Temp\\AdSync\\users.csv', warnings: [] },
    })
    expect(row.proposal!.end).toBe(25)
    expect(row.proposal!.literal).toBe('C:\\Temp\\AdSync')
    expect(row.proposal!.suffix).toBe('\\users.csv')
  })
})

describe('derived fields', () => {
  it('resolves {{ROOT}} templates and follows a root change', async () => {
    let t = 0
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString()
    const { session } = await VaultSession.create(new VaultStore('derived-test'), 'pw', { iterations: 1000, now })
    const root = await session.createField({ name: 'ROOT', kind: 'path', real: 'C:\\Temp', example: 'C:\\Example' })
    const proj = await session.createField({ name: 'PROJECT_ROOT', kind: 'path', real: 'C:\\Temp\\AdSync', template: '{{ROOT}}\\AdSync' })
    expect(session.realValue(proj.id)).toBe('C:\\Temp\\AdSync')
    await session.updateField(root.id, { real: 'D:\\Scripts' })
    expect(session.realValue(proj.id)).toBe('D:\\Scripts\\AdSync')
    expect(session.snapshot().real.get(proj.id)).toBe('D:\\Scripts\\AdSync')
    expect(session.findFieldByRealValue('D:\\Scripts\\AdSync')?.id).toBe(proj.id)
  })
})

/**
 * What the review step's "Ändringar" tab shows: the version the current
 * decisions would produce, against the one before it. Driven by buildVersion,
 * so it moves as decisions move.
 */
describe('live diff of the pending version', () => {
  const mk = (id: string, kind: Field['kind'], example: string): Field =>
    createField({ id, name: id.toUpperCase(), kind, example, now: NOW })

  const fields = [mk('user', 'username', 'svc-example01'), mk('pw', 'password', 'Ex@mple-Passw0rd-1')]
  const fieldMap = new Map(fields.map((f) => [f.id, f]))
  const real = new Map([['user', 'svc-adsync'], ['pw', 'Sommar2024!']])
  const paste = "$u = 'svc-example01'\n$p = 'Ex@mple-Passw0rd-1'\n"

  const pending = (mutate: (rows: ReturnType<typeof initialRows>) => ReturnType<typeof initialRows> = (r) => r) => {
    const result = reapply({ text: paste, fields, real, mode: 'ai' })
    const rows = mutate(initialRows(result))
    const built = buildVersion(paste, rows, result.missing, new Set(), fieldMap, NOW)
    return diffDoc(built.segments, fieldMap)
  }

  it('an unchanged paste diffs to nothing against the version it came from', () => {
    const next = pending()
    expect(diffStats(next, next)).toMatchObject({ added: 0, removed: 0 })
    // Fields are atomic markers, so no real value can be in either document.
    expect(next).toContain('⟦PW⟧')
    expect(next).not.toContain('Sommar2024!')
    expect(next).not.toContain('Ex@mple-Passw0rd-1')
  })

  it('rejecting a finding changes the document, which is what makes it live', () => {
    const accepted = pending()
    const rejected = pending((rows) => rows.map((r) => (r.fieldId === 'pw' ? { ...r, decision: 'reject' as const } : r)))
    expect(rejected).not.toBe(accepted)
    // The rejected slot stays plain text: the example value, never the real one.
    expect(rejected).not.toContain('⟦PW⟧')
    expect(rejected).toContain('Ex@mple-Passw0rd-1')
    expect(rejected).not.toContain('Sommar2024!')
    expect(diffStats(accepted, rejected).added).toBeGreaterThan(0)
  })
})
