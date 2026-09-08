import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { diffDoc, diffStats, formatStats, markersToExamples } from '@ui/diff'
import { directoryPart, trimPathRow } from '@ui/review'
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
