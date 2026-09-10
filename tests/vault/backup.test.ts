import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { VaultStore } from '@vault/store'
import { VaultSession } from '@vault/session'
import {
  backupFilename,
  backupIsUnprotected,
  buildBackup,
  buildStructureExport,
  compareOrigin,
  openBackup,
  parseBackup,
  restoreIntoStore,
  serializeBackup,
  structureExportStrings,
  testRestore,
} from '@vault/backup'
import { VaultKeyError, type VaultHeader } from '@vault/crypto'
import { guardShortText } from '@engine/guard'
import { parseTemplate } from '@engine/template'

let dbCounter = 0
const newStore = () => new VaultStore(`backup-test-${++dbCounter}`)
const clock = () => {
  let t = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString()
}
const ITER = 1000

async function seeded() {
  const store = newStore()
  const now = clock()
  const { session, recoveryKey } = await VaultSession.create(store, 'pw', { iterations: ITER, now, deviceId: 'dev-A' })
  const script = await session.createScript({ title: 'AD sync' })
  const user = await session.createField({ name: 'SVC_USER', kind: 'username', real: 'svc-adsync' })
  const pw = await session.createField({ name: 'SVC_PW', kind: 'password', real: 'Sommar2024!' })
  await session.addVersion({
    scriptId: script.id,
    segments: parseTemplate(`$u = '⟦f:${user.id}|sq⟧'\n$p = '⟦f:${pw.id}|sq⟧'`),
    source: 'ai',
    eol: 'crlf',
    note: 'first',
  })
  await session.updateField(pw.id, { real: 'Host2025!' })
  await session.createPreset({ name: 'Kort servernamn', kind: 'server', value: 'web-frontend.acme-demo.net' })
  return { store, session, recoveryKey, script, user, pw, now }
}

describe('backup', () => {
  it('round-trips through serialize/parse and reports counts on test restore', async () => {
    const { store, session, recoveryKey } = await seeded()
    const backup = buildBackup(session.header, await store.allRaw())
    const text = serializeBackup(backup)
    expect(text).not.toContain('Sommar2024!')
    expect(text).not.toContain('svc-adsync')
    const parsed = parseBackup(text)
    const result = await testRestore(parsed, { password: 'pw' })
    expect(result.counts).toEqual({ script: 1, version: 1, field: 2, retired: 1, preset: 1, settings: 1 })
    await expect(testRestore(parsed, { password: 'wrong' })).rejects.toThrow()
    const viaRecovery = await openBackup(parsed, { recoveryKey })
    expect(viaRecovery.records.some((r) => r.type === 'field')).toBe(true)
    expect(() => parseBackup('{"magic":"nope"}')).toThrow(/Not a CodeVault backup/)
    expect(backupFilename(new Date(2026, 8, 6, 13, 5))).toBe('codevault-20260906-1305.enc')
  })

  it('restores into a fresh store and opens with the same password', async () => {
    const { store, session, script, pw } = await seeded()
    const backup = parseBackup(serializeBackup(buildBackup(session.header, await store.allRaw())))
    const fresh = newStore()
    await restoreIntoStore(fresh, backup)
    const re = await VaultSession.open(fresh, { password: 'pw' })
    expect(re.listScripts()[0]!.title).toBe('AD sync')
    expect(re.listVersions(script.id)).toHaveLength(1)
    expect(re.realValue(pw.id)).toBe('Host2025!')
    expect(re.header.deviceId).toBe('dev-A')
    // A record type missing from RECORD_TYPES is dropped silently on backup.
    expect(re.listPresets().map((p) => p.value)).toEqual(['web-frontend.acme-demo.net'])
  })

  it('structure export carries templates but never a real value', async () => {
    const { session, user, pw } = await seeded()
    const exp = buildStructureExport({
      header: session.header,
      scripts: session.listScripts(),
      versions: session.listScripts().flatMap((s) => session.listVersions(s.id)),
      fields: session.listFields(true),
    })
    expect(exp.versions[0]!.template).toBe(`$u = '⟦f:${user.id}|sq⟧'\n$p = '⟦f:${pw.id}|sq⟧'`)
    expect(exp.fields.map((f) => f.example).sort()).toEqual(['Ex@mple-Passw0rd-1', 'svc-example01'])
    const json = JSON.stringify(exp)
    for (const real of ['svc-adsync', 'Sommar2024!', 'Host2025!']) expect(json).not.toContain(real)
    const snap = session.snapshot()
    for (const s of structureExportStrings(exp)) {
      expect(guardShortText(s, { fields: snap.all, real: snap.real, retired: snap.retired }).blocked, s).toBe(false)
    }
  })

  it('a backup of a protected vault carries no key of its own', async () => {
    const { store, session } = await seeded()
    const backup = buildBackup(session.header, await store.allRaw(), undefined, 'a-stray-key')
    expect(backup.localKey).toBeUndefined()
    expect(backupIsUnprotected(backup)).toBe(false)
    await expect(openBackup(backup, null)).rejects.toBeInstanceOf(VaultKeyError)
  })

  it('a backup of an unprotected vault carries its key, and says so', async () => {
    const store = newStore()
    const now = clock()
    const session = await VaultSession.createUnprotected(store, { now, deviceId: 'dev-A' })
    await session.createScript({ title: 'AD sync' })
    const pw = await session.createField({ name: 'SVC_PW', kind: 'password', real: 'Sommar2024!' })

    const localKey = await store.localKey()
    const backup = parseBackup(serializeBackup(buildBackup(session.header, await store.allRaw(), undefined, localKey)))
    expect(backupIsUnprotected(backup)).toBe(true)
    // the values are still encrypted in the file; it is the bundled key that opens it
    expect(serializeBackup(backup)).not.toContain('Sommar2024!')
    const opened = await openBackup(backup, null)
    expect(opened.records.some((r) => r.type === 'field')).toBe(true)

    // restoring elsewhere needs no secret, and the key lands in the new store
    const fresh = newStore()
    await restoreIntoStore(fresh, backup)
    expect(await fresh.localKey()).toBe(localKey)
    const re = await VaultSession.open(fresh, null)
    expect(re.listScripts()[0]!.title).toBe('AD sync')
    expect(re.realValue(pw.id)).toBe('Sommar2024!')
  })

  it('restoring a protected backup clears a local key left by an earlier vault', async () => {
    const { store, session } = await seeded()
    const backup = parseBackup(serializeBackup(buildBackup(session.header, await store.allRaw())))
    const fresh = newStore()
    await fresh.writeLocalKey('stale-key-from-a-previous-vault')
    await restoreIntoStore(fresh, backup)
    expect(await fresh.localKey()).toBeUndefined()
    await expect(VaultSession.open(fresh, null)).rejects.toBeInstanceOf(VaultKeyError)
    expect((await VaultSession.open(fresh, { password: 'pw' })).listScripts()[0]!.title).toBe('AD sync')
  })

  it('compareOrigin flags other devices and newer revisions', () => {
    const base: VaultHeader = {
      formatVersion: 2,
      vaultId: 'V1',
      protection: 'password',
      appVersion: '0',
      deviceId: 'A',
      revision: 5,
      kdf: { salt: 's', iterations: 1, hash: 'SHA-256' },
      recoveryKdf: { salt: 'r', iterations: 1, hash: 'SHA-256' },
      wrappedDEK: 'w',
      wrappedDEKRecovery: 'wr',
      namespaceIndex: 0,
      createdAt: '',
      updatedAt: '',
    }
    const other = { ...base, deviceId: 'B', revision: 9 }
    const o = compareOrigin(base, other)
    expect(o).toMatchObject({ sameVault: true, fromOtherDevice: true, incomingIsNewer: true, incomingRevision: 9, localRevision: 5 })
    expect(compareOrigin(base, { ...base, revision: 2 }).incomingIsNewer).toBe(false)
    expect(compareOrigin(undefined, other).fromOtherDevice).toBe(true)
    expect(compareOrigin(base, { ...other, vaultId: 'V2' }).sameVault).toBe(false)
    // an unprotected vault has no salts at all, so the id is the only thing telling two apart
    const open1: VaultHeader = { ...base, protection: 'none', vaultId: 'O1', kdf: undefined, recoveryKdf: undefined, wrappedDEK: undefined, wrappedDEKRecovery: undefined }
    expect(compareOrigin(open1, { ...open1, revision: 9 }).sameVault).toBe(true)
    expect(compareOrigin(open1, { ...open1, vaultId: 'O2' }).sameVault).toBe(false)
  })

  it('compareOrigin still matches format-1 headers, which carry no vault id', () => {
    const legacy = {
      formatVersion: 1,
      appVersion: '0',
      deviceId: 'A',
      revision: 5,
      kdf: { salt: 's', iterations: 1, hash: 'SHA-256' as const },
      recoveryKdf: { salt: 'r', iterations: 1, hash: 'SHA-256' as const },
      wrappedDEK: 'w',
      wrappedDEKRecovery: 'wr',
      namespaceIndex: 0,
      createdAt: '',
      updatedAt: '',
    } as unknown as VaultHeader
    expect(compareOrigin(legacy, { ...legacy, deviceId: 'B', revision: 9 }).sameVault).toBe(true)
    expect(compareOrigin(legacy, { ...legacy, kdf: { salt: 'x', iterations: 1, hash: 'SHA-256' }, wrappedDEKRecovery: 'y' }).sameVault).toBe(false)
  })
})
