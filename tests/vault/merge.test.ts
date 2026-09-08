import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { VaultStore } from '@vault/store'
import { VaultSession } from '@vault/session'
import { buildBackup, openBackup, parseBackup, restoreIntoStore, serializeBackup } from '@vault/backup'
import { planIsEmpty, planMerge } from '@vault/merge'
import { LockController } from '@vault/lock'

let dbCounter = 0
const newStore = () => new VaultStore(`merge-test-${++dbCounter}`)
const ITER = 1000

describe('merge between two machines', () => {
  it('unions versions, resolves fields by last writer, keeps the local stable star, and is idempotent', async () => {
    let t = 0
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString()

    // Machine A
    const storeA = newStore()
    const { session: A } = await VaultSession.create(storeA, 'pw', { iterations: ITER, now, deviceId: 'A' })
    const script = await A.createScript({ title: 'Sync' })
    const field = await A.createField({ name: 'PW', kind: 'password', real: 'Old1!' })
    const v1 = await A.addVersion({ scriptId: script.id, segments: [{ t: 'text', s: 'v1' }], source: 'ai', eol: 'lf' })

    // Backup A -> restore on machine B
    const backupA = parseBackup(serializeBackup(buildBackup(A.header, await storeA.allRaw())))
    const storeB = newStore()
    await restoreIntoStore(storeB, backupA)
    const B = await VaultSession.open(storeB, { password: 'pw' }, { now })

    // Both machines continue independently; B's edits are the later ones
    await A.addVersion({ scriptId: script.id, segments: [{ t: 'text', s: 'v2 from A' }], source: 'editor', eol: 'lf', parentVersionId: v1.id })
    await A.updateScript(script.id, { stableVersionId: v1.id })
    await A.addExclusion(script.id, field.id, '# fp')

    await B.addVersion({ scriptId: script.id, segments: [{ t: 'text', s: 'v2 from B' }], source: 'ai', eol: 'lf', parentVersionId: v1.id })
    await B.updateField(field.id, { real: 'New2!' })
    await B.addAllowlist('10.9.9.9')
    await B.updateScript(script.id, { title: 'Sync (renamed on B)' })

    // Merge B's backup into A
    const backupB = parseBackup(serializeBackup(buildBackup(B.header, await storeB.allRaw())))
    const incoming = (await openBackup(backupB, { password: 'pw' })).records
    const plan = planMerge(await A.allDecoded(), incoming)
    expect(plan.summary).toMatchObject({ versionsAdded: 1, fieldsUpdated: 1, allowlistAdded: 1, retiredAdded: 1, scriptsUpdated: 1, scriptsAdded: 0 })
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toMatchObject({ fieldId: field.id, resolution: 'took-incoming' })
    expect(plan.conflicts[0]!.differing).toContain('valueByProfile')
    expect(plan.preview).toEqual([{ scriptId: script.id, title: 'Sync', incomingVersions: 2, alreadyPresent: 1, newVersions: 1, isNewScript: false }])

    await A.applyMerge(plan)
    const versions = A.listVersions(script.id)
    expect(versions.map((v) => v.seq)).toEqual([1, 2, 3])
    expect(versions.map((v) => (v.segments[0] as { s: string }).s)).toEqual(['v1', 'v2 from A', 'v2 from B'])
    expect(A.realValue(field.id)).toBe('New2!')
    expect(A.listRetired().map((r) => r.value)).toEqual(['Old1!'])
    expect(A.listAllowlist().map((a) => a.value)).toEqual(['10.9.9.9'])
    const merged = A.getScript(script.id)!
    expect(merged.title).toBe('Sync (renamed on B)')
    expect(merged.stableVersionId).toBe(v1.id)
    expect(A.listExclusions(script.id)).toHaveLength(1)

    // Idempotent
    const again = planMerge(await A.allDecoded(), incoming)
    expect(planIsEmpty(again)).toBe(true)
    expect(again.conflicts).toEqual([])

    // A's own backup merged into itself is also empty
    const backupA2 = parseBackup(serializeBackup(buildBackup(A.header, await storeA.allRaw())))
    const self = planMerge(await A.allDecoded(), (await openBackup(backupA2, { password: 'pw' })).records)
    expect(planIsEmpty(self)).toBe(true)
  })

  it('a backup from a brand-new script on another device is added whole', async () => {
    let t = 0
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString()
    const storeA = newStore()
    const { session: A } = await VaultSession.create(storeA, 'pw', { iterations: ITER, now, deviceId: 'A' })
    const backupA = parseBackup(serializeBackup(buildBackup(A.header, await storeA.allRaw())))
    const storeB = newStore()
    await restoreIntoStore(storeB, backupA)
    const B = await VaultSession.open(storeB, { password: 'pw' }, { now })
    const s = await B.createScript({ title: 'Only on B' })
    await B.addVersion({ scriptId: s.id, segments: [{ t: 'text', s: 'x' }], source: 'ai', eol: 'lf' })
    await B.addVersion({ scriptId: s.id, segments: [{ t: 'text', s: 'y' }], source: 'ai', eol: 'lf' })
    const incoming = (await openBackup(parseBackup(serializeBackup(buildBackup(B.header, await storeB.allRaw()))), { password: 'pw' })).records
    const plan = planMerge(await A.allDecoded(), incoming)
    expect(plan.summary).toMatchObject({ scriptsAdded: 1, versionsAdded: 2 })
    expect(plan.preview[0]).toMatchObject({ title: 'Only on B', isNewScript: true, newVersions: 2 })
    await A.applyMerge(plan)
    expect(A.listVersions(s.id).map((v) => v.seq)).toEqual([1, 2])
  })
})

describe('LockController', () => {
  it('locks on idle, on hidden tab, and stops after firing', () => {
    const timers: Array<{ fn: () => void; ms: number; id: number }> = []
    let nextId = 1
    let locked = 0
    const ctl = new LockController({
      idleMs: 1000,
      hiddenMs: 200,
      onLock: () => locked++,
      setTimeout: (fn, ms) => {
        const id = nextId++
        timers.push({ fn, ms, id })
        return id
      },
      clearTimeout: (h) => {
        const i = timers.findIndex((t) => t.id === h)
        if (i >= 0) timers.splice(i, 1)
      },
    })
    ctl.start()
    expect(timers.map((t) => t.ms)).toEqual([1000])
    ctl.activity(5000)
    expect(timers.map((t) => t.ms)).toEqual([1000])
    ctl.documentHidden()
    expect(timers.map((t) => t.ms)).toEqual([1000, 200])
    ctl.documentVisible()
    expect(timers.map((t) => t.ms)).toEqual([1000])
    ctl.documentHidden()
    timers.find((t) => t.ms === 200)!.fn()
    expect(locked).toBe(1)
    expect(timers).toEqual([])
    ctl.activity(99999)
    expect(timers).toEqual([])
  })
})
