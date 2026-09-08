import { describe, expect, it } from 'vitest'
import {
  VaultKeyError,
  WrongPasswordError,
  addPassword,
  changePassword,
  createUnprotectedVault,
  createVault,
  decryptRecord,
  encryptRecord,
  formatRecoveryKey,
  normalizeHeader,
  normalizeRecoveryKey,
  removePassword,
  rotateRecoveryKey,
  unlockWithLocalKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  type VaultHeader,
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

  it('an unprotected vault opens with its local key and nothing else', async () => {
    const v = await createUnprotectedVault()
    expect(v.header.protection).toBe('none')
    expect(v.header.wrappedDEK).toBeUndefined()
    expect(v.header.kdf).toBeUndefined()
    const ct = await encryptRecord(v.dek, 'secret text', 'field:1')
    const dek = await unlockWithLocalKey(v.header, v.localKey)
    expect(await decryptRecord(dek, ct, 'field:1')).toBe('secret text')
    // the key check turns another vault's key into a clear error, not a decrypt failure later
    const other = await createUnprotectedVault()
    await expect(unlockWithLocalKey(v.header, other.localKey)).rejects.toBeInstanceOf(VaultKeyError)
    await expect(unlockWithLocalKey(v.header, 'not-base64!!')).rejects.toBeInstanceOf(VaultKeyError)
  })

  it('addPassword protects a vault in place: records stay readable, the local key stops working', async () => {
    const v = await createUnprotectedVault()
    const ct = await encryptRecord(v.dek, 'secret text', 'field:1')
    const { header, recoveryKey } = await addPassword(v.header, v.localKey, 'hunter2-correct', { iterations: ITER })
    expect(header.protection).toBe('password')
    expect(header.keyCheck).toBeUndefined()
    // same DEK, so nothing had to be re-encrypted
    const dek = await unlockWithPassword(header, 'hunter2-correct')
    expect(await decryptRecord(dek, ct, 'field:1')).toBe('secret text')
    expect(await decryptRecord(await unlockWithRecoveryKey(header, recoveryKey), ct, 'field:1')).toBe('secret text')
    await expect(unlockWithPassword(header, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
    await expect(unlockWithLocalKey(header, v.localKey)).rejects.toBeInstanceOf(VaultKeyError)
    await expect(addPassword(header, v.localKey, 'again')).rejects.toBeTruthy()
  })

  it('removePassword hands the key back and retires the recovery key', async () => {
    const v = await createVault('pw', { iterations: ITER })
    const ct = await encryptRecord(v.dek, 'secret text', 'field:1')
    const { header, localKey } = await removePassword(v.header, { password: 'pw' })
    expect(header.protection).toBe('none')
    expect(header.wrappedDEK).toBeUndefined()
    expect(header.wrappedDEKRecovery).toBeUndefined()
    expect(await decryptRecord(await unlockWithLocalKey(header, localKey), ct, 'field:1')).toBe('secret text')
    await expect(unlockWithPassword(header, 'pw')).rejects.toBeInstanceOf(VaultKeyError)
    await expect(unlockWithRecoveryKey(header, v.recoveryKey)).rejects.toBeInstanceOf(VaultKeyError)
    await expect(removePassword(header, { password: 'pw' })).rejects.toBeTruthy()
    // a password can be put back on afterwards
    const again = await addPassword(header, localKey, 'second-password', { iterations: ITER })
    expect(await decryptRecord(await unlockWithPassword(again.header, 'second-password'), ct, 'field:1')).toBe('secret text')
  })

  it('normalizeHeader reads a format-1 header as password-protected', () => {
    const legacy = {
      formatVersion: 1,
      appVersion: '0',
      deviceId: 'A',
      revision: 0,
      kdf: { salt: 'the-salt', iterations: 1, hash: 'SHA-256' as const },
      recoveryKdf: { salt: 'r', iterations: 1, hash: 'SHA-256' as const },
      wrappedDEK: 'w',
      wrappedDEKRecovery: 'wr',
      namespaceIndex: 0,
      createdAt: '',
      updatedAt: '',
    } as unknown as VaultHeader
    const h = normalizeHeader(legacy)
    expect(h.protection).toBe('password')
    expect(h.vaultId).toBe('the-salt')
    expect(normalizeHeader(h)).toBe(h)
  })
})
