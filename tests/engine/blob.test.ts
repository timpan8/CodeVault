import { describe, expect, it } from 'vitest'
import { analyzeBlock, buildBlobExample } from '@engine/blob'
import { directEngine } from '@engine/client'
import { createField } from '@engine/fields'
import { layoutSegments, insertSlot, removeSlot, selectionInfo } from '@ui/layout'
import { parseTemplate, serializeTemplate } from '@engine/template'

const HT = `@(
    @{ Name = 'Anna Andersson'; UPN = 'anna.andersson@contoso.com'; Department = 'IT' },
    @{ Name = 'Erik Eriksson'; UPN = 'erik.eriksson@contoso.com'; Department = 'HR' },
    @{ Name = 'Lisa Larsson'; UPN = 'lisa.larsson@contoso.com'; Department = 'Ekonomi' }
)`

describe('blob fields', () => {
  it('analyses hashtable arrays and csv here-strings', () => {
    expect(analyzeBlock(HT)).toEqual({ kind: 'hashtables', columns: ['Name', 'UPN', 'Department'], rows: 3 })
    const csv = "@'\nName;UPN\nA;a@x.se\nB;b@x.se\n'@"
    expect(analyzeBlock(csv)).toEqual({ kind: 'csv', columns: ['Name', 'UPN'], rows: 2, delimiter: ';' })
  })

  it('builds a two-row example with the same keys and no real rows', () => {
    const ex = buildBlobExample(HT, 1)
    expect(ex).toContain("Name = 'Name-example1'")
    expect(ex).toContain("UPN = 'anna.exempel1@example.com'")
    expect(ex).toContain('EXAMPLE-BLOCK-01: 3 rows')
    expect(ex).not.toContain('Anna Andersson')
    expect(ex.split('@{').length - 1).toBe(2)
  })

  it('a blob field is re-applied on the whole text and rendered raw', async () => {
    const field = { ...createField({ id: 'b', name: 'USERS', kind: 'blob', example: buildBlobExample(HT, 1), now: '2026-01-01' }) }
    const paste = `$Users = ${field.example}\nforeach ($u in $Users) { New-MgUser -DisplayName $u.Name }`
    const res = await directEngine.reapply({ text: paste, fields: [field], mode: 'ai', real: [['b', HT]] })
    expect(res.slots.map((s) => [s.fieldId, s.status, s.why])).toEqual([['b', 'auto', 'literal']])
    const editor = await directEngine.reapply({ text: `$Users = ${HT}`, fields: [field], mode: 'editor', real: [['b', HT]] })
    expect(editor.slots.map((s) => [s.fieldId, s.status, s.why])).toEqual([['b', 'auto', 'real']])
  })
})

describe('editor layout helpers', () => {
  const user = createField({ id: 'u', name: 'USER', kind: 'username', example: 'svc-example01', now: '2026-01-01' })
  const fields = new Map([[user.id, user]])

  it('layouts slots at document offsets', () => {
    const segs = parseTemplate("$u = '⟦f:u|sq⟧'\n$x = 1")
    const l = layoutSegments(segs, fields)
    expect(l.text).toBe("$u = 'svc-example01'\n$x = 1")
    expect(l.slots).toEqual([{ from: 6, to: 19, fieldId: 'u', segmentIndex: 1, quote: 'sq', status: 'auto', regex: false, missingField: false }])
  })

  it('selectionInfo snaps to the literal and unescapes', () => {
    const text = "$p = 'it''s'\n$q = \"a`$b\""
    const whole = selectionInfo(text, 7, 7)!
    expect(whole).toMatchObject({ from: 6, to: 11, raw: "it''s", logical: "it's", quote: 'sq', wholeLiteral: true, bindingName: 'p' })
    const part = selectionInfo(text, 19, 23)!
    expect(part).toMatchObject({ raw: 'a`$b', logical: 'a$b', quote: 'dq' })
  })

  it('insertSlot and removeSlot round-trip', () => {
    const segs = parseTemplate("$u = 'svc-example01'\n$p = 'Ex@mple-Passw0rd-1'")
    const pw = createField({ id: 'p', name: 'PW', kind: 'password', example: 'Ex@mple-Passw0rd-1', now: '2026-01-01' })
    const all = new Map([...fields, [pw.id, pw]])
    const withUser = insertSlot(segs, all, 6, 19, { fieldId: 'u', quote: 'sq' })
    expect(serializeTemplate(withUser)).toBe("$u = '⟦f:u|sq⟧'\n$p = 'Ex@mple-Passw0rd-1'")
    const both = insertSlot(withUser, all, 27, 45, { fieldId: 'p', quote: 'sq' })
    expect(serializeTemplate(both)).toBe("$u = '⟦f:u|sq⟧'\n$p = '⟦f:p|sq⟧'")
    expect(() => insertSlot(both, all, 5, 10, { fieldId: 'p', quote: 'sq' })).toThrow(/overlaps/)
    const back = removeSlot(both, all, 1)
    expect(serializeTemplate(back)).toBe("$u = 'svc-example01'\n$p = '⟦f:p|sq⟧'")
  })
})
