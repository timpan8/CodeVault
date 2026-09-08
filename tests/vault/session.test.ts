import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { VaultStore } from '@vault/store'
import { ExampleInvalidError, LockedError, VaultSession, materializeField } from '@vault/session'
import { parseTemplate, render, serializeTemplate } from '@engine/template'

let dbCounter = 0
const newStore = () => new VaultStore(`session-test-${++dbCounter}`)
const clock = () => {
  let t = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString()
}
const ITER = 1000

describe('VaultSession', () => {
  it('creates, persists and reopens with the password; revision increments', async () => {
    const store = newStore()
    const now = clock()
    const { session, recoveryKey } = await VaultSession.create(store, 'pw', { iterations: ITER, now })
    expect(recoveryKey).toMatch(/^[0-9a-f]{32}$/)
    const r0 = session.header.revision
    const script = await session.createScript({ title: 'AD sync' })
    const field = await session.createField({ name: 'SVC_USER', kind: 'username', real: 'svc-adsync', nameAnchors: ['$Username'] })
    expect(field.example).toBe('svc-example01')
    expect(field.nameAnchors).toEqual(['username'])
    const segs = parseTemplate(`$Username = '⟦f:${field.id}|sq⟧'`)
    const v1 = await session.addVersion({ scriptId: script.id, segments: segs, source: 'ai', eol: 'crlf' })
    expect(v1.seq).toBe(1)
    expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(session.header.revision).toBeGreaterThan(r0)

    session.lock()
    expect(session.isLocked).toBe(true)
    expect(() => session.listScripts()).toThrow(LockedError)

    const reopened = await VaultSession.open(store, { password: 'pw' }, { now })
    expect(reopened.listScripts().map((s) => s.title)).toEqual(['AD sync'])
    expect(reopened.listVersions(script.id)).toHaveLength(1)
    expect(reopened.realValue(field.id)).toBe('svc-adsync')
    expect(serializeTemplate(reopened.getVersion(v1.id)!.segments)).toBe(serializeTemplate(segs))
    await expect(VaultSession.open(store, { password: 'nope' })).rejects.toThrow()
    await expect(VaultSession.open(store, { recoveryKey })).resolves.toBeTruthy()
  })

  it('changing a real value retires the old one and clears exposure', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    const f = await session.createField({ name: 'PW', kind: 'password', real: 'Vinter2023!' })
    await session.updateField(f.id, { exposedAt: '2026-01-01' })
    const updated = await session.updateField(f.id, { real: 'Sommar2024!' })
    expect(updated.previousValue).toBe('Vinter2023!')
    expect(updated.exposedAt).toBeUndefined()
    const snap = session.snapshot()
    expect(snap.retired).toEqual([{ fieldId: f.id, value: 'Vinter2023!' }])
    expect(snap.real.get(f.id)).toBe('Sommar2024!')
  })

  it('example generation is unique and validated', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    const a = await session.createField({ name: 'A', kind: 'server', real: 'dc01.corp.local' })
    const b = await session.createField({ name: 'B', kind: 'server', real: 'dc02' })
    expect(a.example).toBe('SRV-EXAMPLE01.corp.example')
    expect(b.example).toBe('SRV-EXAMPLE02')
    await expect(session.createField({ name: 'C', kind: 'server', example: 'SRV-EXAMPLE01.corp.example' })).rejects.toBeInstanceOf(
      ExampleInvalidError,
    )
    await expect(session.createField({ name: 'D', kind: 'custom', example: 'ab' })).rejects.toBeInstanceOf(ExampleInvalidError)
  })

  it('a real value inside the fake namespace switches the namespace', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    expect(session.header.namespaceIndex).toBe(0)
    const f = await session.createField({ name: 'LAB', kind: 'domain', real: 'corp.example' })
    expect(session.header.namespaceIndex).toBe(1)
    expect(f.example).toBe('corp.exmpl')
  })

  it('hard delete materialises the example, soft delete tombstones; both retire the value', async () => {
    const now = clock()
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now })
    const script = await session.createScript({ title: 'x' })
    const pw = await session.createField({ name: 'PW', kind: 'password', real: 'Pa$$w0rd' })
    const user = await session.createField({ name: 'USER', kind: 'username', real: 'jdoe' })
    const segs = parseTemplate(`$p = "⟦f:${pw.id}|dq⟧"\n$u = '⟦f:${user.id}|sq⟧'`)
    const v = await session.addVersion({ scriptId: script.id, segments: segs, source: 'ai', eol: 'lf' })
    expect(session.fieldUsage(pw.id)).toEqual([{ scriptId: script.id, versionId: v.id, seq: 1, count: 1 }])

    await session.deleteField(pw.id, 'hard')
    const after = session.getVersion(v.id)!
    expect(serializeTemplate(after.segments)).toBe(`$p = "Ex@mple-Passw0rd-1"\n$u = '⟦f:${user.id}|sq⟧'`)
    expect(session.getField(pw.id)).toBeUndefined()
    expect(session.listRetired().map((r) => r.value)).toEqual(['Pa$$w0rd'])

    await session.deleteField(user.id, 'soft')
    expect(session.getField(user.id)?.tombstone).toBe(true)
    expect(session.listFields()).toHaveLength(0)
    expect(session.listFields(true)).toHaveLength(1)
    expect(session.listRetired().map((r) => r.value).sort()).toEqual(['Pa$$w0rd', 'jdoe'])
    // tombstoned field still renders its example
    const out = render(session.getVersion(v.id)!.segments, 'example', { fields: session.fieldMap() })
    expect(out.text).toBe(`$p = "Ex@mple-Passw0rd-1"\n$u = 'svc-example01'`)
  })

  it('materializeField never emits the real value and merges text', () => {
    const field = { id: 'f', name: 'F', kind: 'password' as const, sensitivity: 'secret' as const, scope: 'global' as const, example: "it's-example", aliases: [], nameAnchors: [], compare: 'exact' as const, createdAt: '', updatedAt: '' }
    const segs = materializeField(parseTemplate("a '⟦f:f|sq⟧' b"), field)
    expect(segs).toEqual([{ t: 'text', s: "a 'it''s-example' b" }])
  })

  it('version deletion guards and stable star', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    const script = await session.createScript({ title: 'x' })
    const v1 = await session.addVersion({ scriptId: script.id, segments: [{ t: 'text', s: 'a' }], source: 'ai', eol: 'lf' })
    await expect(session.deleteVersion(v1.id)).rejects.toThrow(/only version/)
    const v2 = await session.addVersion({ scriptId: script.id, segments: [{ t: 'text', s: 'b' }], source: 'ai', eol: 'lf', parentVersionId: v1.id })
    await session.updateScript(script.id, { stableVersionId: v1.id })
    await expect(session.deleteVersion(v1.id)).rejects.toThrow(/stable/)
    await session.deleteVersion(v2.id)
    expect(session.listVersions(script.id).map((v) => v.seq)).toEqual([1])
    expect(session.findVersionByHash(script.id, v1.contentHash)?.id).toBe(v1.id)
  })

  it('snapshot splits own and other fields by scope', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    const s1 = await session.createScript({ title: 's1' })
    const s2 = await session.createScript({ title: 's2' })
    const g = await session.createField({ name: 'TENANT', kind: 'tenantId', real: '3f2a9b1c-1234-4abc-9def-123456789abc' })
    const a = await session.createField({ name: 'A', kind: 'username', real: 'a-user', scope: `script:${s1.id}` })
    const b = await session.createField({ name: 'B', kind: 'username', real: 'b-user', scope: `script:${s2.id}` })
    const snap = session.snapshot(s1.id)
    expect(snap.own.map((f) => f.id).sort()).toEqual([g.id, a.id].sort())
    expect(snap.other.map((f) => f.id)).toEqual([b.id])
    expect(snap.all).toHaveLength(3)
    expect(snap.real.size).toBe(3)
  })

  it('allow-list entries containing a new real value are purged', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    await session.addAllowlist('dc01.contoso.local')
    await session.addAllowlist('10.0.0.5')
    await session.createField({ name: 'DOM', kind: 'domain', real: 'contoso.local' })
    expect(session.listAllowlist().map((a) => a.value)).toEqual(['10.0.0.5'])
  })

  it('settings and exclusions persist', async () => {
    const store = newStore()
    const now = clock()
    const { session } = await VaultSession.create(store, 'pw', { iterations: ITER, now })
    await session.updateSettings({ rootPath: 'C:\\Temp', orgHostRegex: '^(SRV|DC)-' })
    const script = await session.createScript({ title: 'x' })
    await session.addExclusion(script.id, 'f1', '# run as (service account)')
    await session.addExclusion(script.id, 'f1', '# run as (service account)')
    session.lock()
    const re = await VaultSession.open(store, { password: 'pw' }, { now })
    expect(re.getSettings().rootPath).toBe('C:\\Temp')
    expect(re.snapshot(script.id).orgHostRegex?.test('SRV-01')).toBe(true)
    expect(re.listExclusions(script.id)).toHaveLength(1)
  })
})
