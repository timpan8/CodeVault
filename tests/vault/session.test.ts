import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { VaultStore } from '@vault/store'
import { ExampleInvalidError, LockedError, VaultSession, materializeField } from '@vault/session'
import { VaultKeyError } from '@vault/crypto'
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

  it('changing an example value keeps the old one as an alias', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    const f = await session.createField({ name: 'WEB', kind: 'server', real: 'web01.corp.local' })
    expect(f.example).toBe('SRV-EXAMPLE01.corp.example')

    const changed = await session.updateField(f.id, { example: 'web-frontend.acme-demo.net' })
    expect(changed.example).toBe('web-frontend.acme-demo.net')
    // The AI has already written the old value; it must keep matching.
    expect(changed.aliases).toEqual([{ value: 'SRV-EXAMPLE01.corp.example', anchorOnly: false }])

    // Idempotent: setting the same value again adds nothing.
    const again = await session.updateField(f.id, { example: 'web-frontend.acme-demo.net' })
    expect(again.aliases).toHaveLength(1)
  })

  it('an invalid new example value is refused and the field is untouched', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    const a = await session.createField({ name: 'A', kind: 'server', real: 'dc01.corp.local' })
    const b = await session.createField({ name: 'B', kind: 'server', real: 'dc02.corp.local' })
    await expect(session.updateField(a.id, { example: b.example })).rejects.toBeInstanceOf(ExampleInvalidError)
    await expect(session.updateField(a.id, { example: 'ab' })).rejects.toBeInstanceOf(ExampleInvalidError)
    // Its own real value is not "already taken" by itself.
    await expect(session.updateField(a.id, { example: 'dc01.corp.local' })).rejects.toBeInstanceOf(ExampleInvalidError)
    expect(session.getField(a.id)?.example).toBe(a.example)
  })

  it('the real value being set in the same call can never become the example', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    // Nothing in the vault knows this value yet, so it is the one real value
    // that would otherwise go unchecked.
    await expect(session.createField({ name: 'A', kind: 'server', real: 'dc01.corp.local', example: 'dc01.corp.local' })).rejects.toBeInstanceOf(
      ExampleInvalidError,
    )
    const f = await session.createField({ name: 'B', kind: 'server', real: 'dc02.corp.local' })
    await expect(session.updateField(f.id, { real: 'dc03.corp.local', example: 'dc03.corp.local' })).rejects.toBeInstanceOf(
      ExampleInvalidError,
    )
  })

  it('stored versions render the new example value with no rewriting', async () => {
    const { session } = await VaultSession.create(newStore(), 'pw', { iterations: ITER, now: clock() })
    const f = await session.createField({ name: 'WEB', kind: 'server', real: 'web01.corp.local' })
    const script = await session.createScript({ title: 'S', aiVisibleName: 'Project01', language: 'powershell', eol: 'crlf' })
    const segments = parseTemplate(`$s = '\u27e6f:${f.id}|sq\u27e7'`)
    await session.addVersion({ scriptId: script.id, segments, source: 'ai', eol: 'crlf' })

    await session.updateField(f.id, { example: 'web-frontend.acme-demo.net' })
    const v = session.listVersions(script.id)[0]!
    expect(render(v.segments, 'example', { fields: session.fieldMap() }).text).toBe("$s = 'web-frontend.acme-demo.net'")
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

  it('an unprotected vault reopens with no secret', async () => {
    const store = newStore()
    const now = clock()
    const session = await VaultSession.createUnprotected(store, { now })
    expect(session.isProtected).toBe(false)
    const script = await session.createScript({ title: 'AD sync' })
    await session.createField({ name: 'SVC_PW', kind: 'password', real: 'Sommar2024!' })
    expect(await store.localKey()).toBeTruthy()
    session.lock()

    const re = await VaultSession.open(store, null, { now })
    expect(re.listScripts().map((s) => s.title)).toEqual(['AD sync'])
    expect(re.snapshot(script.id).real.get(re.listFields()[0]!.id)).toBe('Sommar2024!')
    // records are still ciphertext on disk; the key is simply stored beside them
    const raw = await store.allRaw()
    expect(raw.length).toBeGreaterThan(0)
    for (const row of raw) expect(row.payload).not.toContain('Sommar2024!')
  })

  it('addPassword protects an open vault, removePassword gives the protection up again', async () => {
    const store = newStore()
    const now = clock()
    const session = await VaultSession.createUnprotected(store, { now })
    await session.createScript({ title: 'AD sync' })

    const recoveryKey = await session.addPassword('hunter2-correct', { iterations: ITER })
    expect(recoveryKey).toMatch(/^[0-9a-f]{32}$/)
    expect(session.isProtected).toBe(true)
    expect(await store.localKey()).toBeUndefined()
    session.lock()

    await expect(VaultSession.open(store, null, { now })).rejects.toBeInstanceOf(VaultKeyError)
    const locked = await VaultSession.open(store, { password: 'hunter2-correct' }, { now })
    expect(locked.listScripts().map((s) => s.title)).toEqual(['AD sync'])

    await locked.removePassword({ password: 'hunter2-correct' })
    expect(locked.isProtected).toBe(false)
    expect(await store.localKey()).toBeTruthy()
    locked.lock()
    const open = await VaultSession.open(store, null, { now })
    expect(open.listScripts().map((s) => s.title)).toEqual(['AD sync'])
  })

  it('opening a protected vault clears a local key an interrupted addPassword left behind', async () => {
    const store = newStore()
    const now = clock()
    const session = await VaultSession.createUnprotected(store, { now })
    await session.createScript({ title: 'AD sync' })
    const stranded = (await store.localKey())!
    await session.addPassword('hunter2-correct', { iterations: ITER })
    // replay the crash: the header says 'password' but the old key row survived
    await store.writeLocalKey(stranded)
    session.lock()

    // the key is never used to get in, and it is gone once the password has been
    const re = await VaultSession.open(store, { password: 'hunter2-correct' }, { now })
    expect(re.listScripts()).toHaveLength(1)
    expect(await store.localKey()).toBeUndefined()
  })

  it('a wrong password leaves a stranded local key alone', async () => {
    const store = newStore()
    const now = clock()
    const session = await VaultSession.createUnprotected(store, { now })
    const stranded = (await store.localKey())!
    await session.addPassword('hunter2-correct', { iterations: ITER })
    await store.writeLocalKey(stranded)
    session.lock()
    await expect(VaultSession.open(store, { password: 'wrong' }, { now })).rejects.toBeTruthy()
    expect(await store.localKey()).toBe(stranded)
  })

  it('a second vault cannot be created over an existing one, protected or not', async () => {
    const store = newStore()
    const now = clock()
    await VaultSession.createUnprotected(store, { now })
    await expect(VaultSession.createUnprotected(store, { now })).rejects.toThrow(/already exists/)
    await expect(VaultSession.create(store, 'pw', { iterations: ITER, now })).rejects.toThrow(/already exists/)
  })
})
