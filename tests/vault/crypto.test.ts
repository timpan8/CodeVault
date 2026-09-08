import { describe, expect, it } from 'vitest'
import {
  WrongPasswordError,
  changePassword,
  createVault,
  decryptRecord,
  encryptRecord,
  formatRecoveryKey,
  normalizeRecoveryKey,
  rotateRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
} from '@vault/crypto'

const ITER = 1000

describe('vault crypto', () => {
  it('creates a vault and unlocks with the password', async () => {
    const v = await createVault('hunter2-correct', { iterations: ITER })
    const dek = await unlockWithPassword(v.header, 'hunter2-correct')
    expect(dek.type).toBe('secret')
    expect(dek.extractable).toBe(false)
    await expect(unlockWithPassword(v.header, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('recovery key unlocks, formatted or raw', async () => {
    const v = await createVault('pw', { iterations: ITER })
    expect(v.recoveryKey).toMatch(/^[0-9a-f]{32}$/)
    const pretty = formatRecoveryKey(v.recoveryKey)
    expect(pretty).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/)
    expect(normalizeRecoveryKey(pretty)).toBe(v.recoveryKey)
    await expect(unlockWithRecoveryKey(v.header, pretty)).resolves.toBeTruthy()
    await expect(unlockWithRecoveryKey(v.header, '00000000000000000000000000000000')).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('changePassword re-wraps the DEK and keeps the recovery key working', async () => {
    const v = await createVault('old', { iterations: ITER })
    const ct = await encryptRecord(v.dek, 'secret text', 'field:1')
    const h2 = await changePassword(v.header, { password: 'old' }, 'new')
    await expect(unlockWithPassword(h2, 'old')).rejects.toBeInstanceOf(WrongPasswordError)
    const dek2 = await unlockWithPassword(h2, 'new')
    expect(await decryptRecord(dek2, ct, 'field:1')).toBe('secret text')
    const dek3 = await unlockWithRecoveryKey(h2, v.recoveryKey)
    expect(await decryptRecord(dek3, ct, 'field:1')).toBe('secret text')
    // password reset via recovery key
    const h3 = await changePassword(h2, { recoveryKey: v.recoveryKey }, 'third')
    await expect(unlockWithPassword(h3, 'third')).resolves.toBeTruthy()
  })

  it('rotateRecoveryKey invalidates the old key', async () => {
    const v = await createVault('pw', { iterations: ITER })
    const { header, recoveryKey } = await rotateRecoveryKey(v.header, 'pw')
    expect(recoveryKey).not.toBe(v.recoveryKey)
    await expect(unlockWithRecoveryKey(header, v.recoveryKey)).rejects.toBeInstanceOf(WrongPasswordError)
    await expect(unlockWithRecoveryKey(header, recoveryKey)).resolves.toBeTruthy()
    await expect(rotateRecoveryKey(v.header, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('records: round trip, AAD binding, key isolation', async () => {
    const v = await createVault('pw', { iterations: ITER })
    const ct = await encryptRecord(v.dek, JSON.stringify({ a: 'åäö', b: 1 }), 'version:abc')
    expect(await decryptRecord(v.dek, ct, 'version:abc')).toBe(JSON.stringify({ a: 'åäö', b: 1 }))
    await expect(decryptRecord(v.dek, ct, 'version:other')).rejects.toBeTruthy()
    const other = await createVault('pw', { iterations: ITER })
    await expect(decryptRecord(other.dek, ct, 'version:abc')).rejects.toBeTruthy()
    const ct2 = await encryptRecord(v.dek, 'x', 'a:1')
    expect(ct2).not.toBe(await encryptRecord(v.dek, 'x', 'a:1'))
  })
})
