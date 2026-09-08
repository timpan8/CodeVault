/**
 * Vault cryptography. Native WebCrypto only, no third-party code.
 *
 * Records are always AES-256-GCM under the DEK (fresh 96-bit IV, AAD = record
 * type + id). What differs between the two protection modes is only how the
 * DEK itself is kept, so switching mode never re-encrypts a single record:
 *
 * 'password'  master password --PBKDF2-SHA256--> KEK, recovery key --> recovery KEK,
 *             DEK wrapped (AES-GCM) by both. Nothing on disk opens the vault.
 * 'none'      the DEK is stored beside the data (see `localKey`). The default,
 *             so the app opens straight up with nothing to type.
 */

export const PBKDF2_ITERATIONS = 600_000
/** 1 = password only. 2 = adds `protection`, `vaultId` and unprotected vaults. */
export const FORMAT_VERSION = 2

/** Encrypted under the DEK in an unprotected header, to catch a wrong local key. */
const KEY_CHECK_PLAINTEXT = 'codevault-key-check'

export interface KdfParams {
  salt: string
  iterations: number
  hash: 'SHA-256'
}

/**
 * 'password' — the DEK is wrapped by the master password and by the recovery
 * key; the vault cannot be opened without one of them.
 * 'none' — the DEK sits next to the data in the same database. Records stay
 * encrypted, but anyone who can read the browser profile holds the key, so
 * this protects nothing on its own. It is the default: the point is to get
 * started without a password, and `addPassword` upgrades later in place.
 */
export type Protection = 'none' | 'password'

export interface VaultHeader {
  formatVersion: number
  /** Stable for the life of the vault; identifies it across devices and backups. */
  vaultId: string
  protection: Protection
  appVersion: string
  deviceId: string
  /** Monotonically increasing per write; used to detect edits from another device. */
  revision: number
  /** The four wrapping fields are present iff protection === 'password'. */
  kdf?: KdfParams
  recoveryKdf?: KdfParams
  wrappedDEK?: string
  wrappedDEKRecovery?: string
  /** Present iff protection === 'none'. */
  keyCheck?: string
  /** Example-namespace index (0 = default); switched when a real value collides. */
  namespaceIndex: number
  createdAt: string
  updatedAt: string
}

/** Thrown when the local key for an unprotected vault is missing or does not fit. */
export class VaultKeyError extends Error {
  constructor(message = 'The vault key for this device is missing or wrong') {
    super(message)
    this.name = 'VaultKeyError'
  }
}

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

export function randomId(): string {
  return globalThis.crypto.randomUUID()
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 32 hex characters, shown once, grouped for reading. */
export function generateRecoveryKey(): string {
  return toHex(randomBytes(16))
}

export function formatRecoveryKey(hex: string): string {
  return hex.replace(/(.{4})/g, '$1-').replace(/-$/, '').toUpperCase()
}

export function normalizeRecoveryKey(input: string): string {
  return input.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
}

async function deriveKek(secret: string, kdf: KdfParams): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: fromBase64(kdf.salt) as BufferSource, iterations: kdf.iterations, hash: kdf.hash },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(12)
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource }, key, plaintext as BufferSource),
  )
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return toBase64(out)
}

async function aesGcmDecrypt(key: CryptoKey, payload: string, aad: string): Promise<Uint8Array> {
  const bytes = fromBase64(payload)
  if (bytes.length < 13) throw new Error('Corrupt payload')
  const iv = bytes.subarray(0, 12)
  const ct = bytes.subarray(12)
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource }, key, ct as BufferSource)
  return new Uint8Array(pt)
}

async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export interface CreatedVault {
  header: VaultHeader
  dek: CryptoKey
  recoveryKey: string
}

export interface CreateOptions {
  iterations?: number
  appVersion?: string
  deviceId?: string
  now?: string
}

export async function createVault(password: string, opts: CreateOptions = {}): Promise<CreatedVault> {
  const now = opts.now ?? new Date().toISOString()
  const kdf: KdfParams = { salt: toBase64(randomBytes(16)), iterations: opts.iterations ?? PBKDF2_ITERATIONS, hash: 'SHA-256' }
  const recoveryKdf: KdfParams = { salt: toBase64(randomBytes(16)), iterations: opts.iterations ?? PBKDF2_ITERATIONS, hash: 'SHA-256' }
  const recoveryKey = generateRecoveryKey()
  const rawDek = randomBytes(32)
  const kek = await deriveKek(password, kdf)
  const rkek = await deriveKek(recoveryKey, recoveryKdf)
  const header: VaultHeader = {
    formatVersion: FORMAT_VERSION,
    vaultId: randomId(),
    protection: 'password',
    appVersion: opts.appVersion ?? '0.0.0',
    deviceId: opts.deviceId ?? randomId(),
    revision: 0,
    kdf,
    recoveryKdf,
    wrappedDEK: await aesGcmEncrypt(kek, rawDek, 'dek'),
    wrappedDEKRecovery: await aesGcmEncrypt(rkek, rawDek, 'dek-recovery'),
    namespaceIndex: 0,
    createdAt: now,
    updatedAt: now,
  }
  const dek = await importDek(rawDek)
  rawDek.fill(0)
  return { header, dek, recoveryKey }
}

async function makeKeyCheck(dek: CryptoKey): Promise<string> {
  return aesGcmEncrypt(dek, enc.encode(KEY_CHECK_PLAINTEXT), 'key-check')
}

export interface CreatedUnprotectedVault {
  header: VaultHeader
  dek: CryptoKey
  /** Base64 DEK, for the caller to store beside the data. This *is* the protection. */
  localKey: string
}

/** A vault with no master password: opens with the local key alone. */
export async function createUnprotectedVault(opts: CreateOptions = {}): Promise<CreatedUnprotectedVault> {
  const now = opts.now ?? new Date().toISOString()
  const rawDek = randomBytes(32)
  const localKey = toBase64(rawDek)
  const dek = await importDek(rawDek)
  rawDek.fill(0)
  const header: VaultHeader = {
    formatVersion: FORMAT_VERSION,
    vaultId: randomId(),
    protection: 'none',
    appVersion: opts.appVersion ?? '0.0.0',
    deviceId: opts.deviceId ?? randomId(),
    revision: 0,
    keyCheck: await makeKeyCheck(dek),
    namespaceIndex: 0,
    createdAt: now,
    updatedAt: now,
  }
  return { header, dek, localKey }
}

/**
 * Fill in the fields added in format 2 so a format-1 vault opens unchanged.
 * Those vaults are always password-protected, and their KDF salt is already
 * unique per vault, so it doubles as the identity they never stored.
 */
export function normalizeHeader(header: VaultHeader): VaultHeader {
  if (header.protection && header.vaultId) return header
  return {
    ...header,
    protection: header.protection ?? 'password',
    vaultId: header.vaultId ?? header.kdf?.salt ?? randomId(),
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong master password or recovery key')
    this.name = 'WrongPasswordError'
  }
}

async function unwrapRaw(secret: string, kdf: KdfParams, wrapped: string, aad: string): Promise<Uint8Array> {
  const kek = await deriveKek(secret, kdf)
  try {
    return await aesGcmDecrypt(kek, wrapped, aad)
  } catch {
    throw new WrongPasswordError()
  }
}

function passwordWrapping(header: VaultHeader): { kdf: KdfParams; wrapped: string } {
  if (!header.kdf || !header.wrappedDEK) throw new VaultKeyError('Vault has no master password')
  return { kdf: header.kdf, wrapped: header.wrappedDEK }
}

function recoveryWrapping(header: VaultHeader): { kdf: KdfParams; wrapped: string } {
  if (!header.recoveryKdf || !header.wrappedDEKRecovery) throw new VaultKeyError('Vault has no recovery key')
  return { kdf: header.recoveryKdf, wrapped: header.wrappedDEKRecovery }
}

async function unwrapCurrent(header: VaultHeader, current: { password: string } | { recoveryKey: string }): Promise<Uint8Array> {
  if ('password' in current) {
    const { kdf, wrapped } = passwordWrapping(header)
    return unwrapRaw(current.password, kdf, wrapped, 'dek')
  }
  const { kdf, wrapped } = recoveryWrapping(header)
  return unwrapRaw(normalizeRecoveryKey(current.recoveryKey), kdf, wrapped, 'dek-recovery')
}

export async function unlockWithPassword(header: VaultHeader, password: string): Promise<CryptoKey> {
  const raw = await unwrapCurrent(header, { password })
  const dek = await importDek(raw)
  raw.fill(0)
  return dek
}

export async function unlockWithRecoveryKey(header: VaultHeader, recoveryKey: string): Promise<CryptoKey> {
  const raw = await unwrapCurrent(header, { recoveryKey })
  const dek = await importDek(raw)
  raw.fill(0)
  return dek
}

/** Open an unprotected vault. The key check turns a stale local key into a clear error. */
export async function unlockWithLocalKey(header: VaultHeader, localKey: string): Promise<CryptoKey> {
  if (header.protection !== 'none') throw new VaultKeyError('Vault is protected by a master password')
  let dek: CryptoKey
  try {
    dek = await importDek(fromBase64(localKey))
  } catch {
    throw new VaultKeyError()
  }
  if (header.keyCheck) {
    try {
      await aesGcmDecrypt(dek, header.keyCheck, 'key-check')
    } catch {
      throw new VaultKeyError()
    }
  }
  return dek
}

/**
 * Turn an unprotected vault into a password-protected one: the DEK is wrapped
 * under the new password and a fresh recovery key, and the local key becomes
 * useless. No record is touched, so this is instant however large the vault is.
 */
export async function addPassword(
  header: VaultHeader,
  localKey: string,
  password: string,
  opts: { iterations?: number; now?: string } = {},
): Promise<{ header: VaultHeader; recoveryKey: string }> {
  if (header.protection !== 'none') throw new Error('Vault already has a master password')
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS
  const raw = fromBase64(localKey)
  const kdf: KdfParams = { salt: toBase64(randomBytes(16)), iterations, hash: 'SHA-256' }
  const recoveryKdf: KdfParams = { salt: toBase64(randomBytes(16)), iterations, hash: 'SHA-256' }
  const recoveryKey = generateRecoveryKey()
  const kek = await deriveKek(password, kdf)
  const rkek = await deriveKek(recoveryKey, recoveryKdf)
  const next: VaultHeader = {
    ...header,
    protection: 'password',
    kdf,
    recoveryKdf,
    wrappedDEK: await aesGcmEncrypt(kek, raw, 'dek'),
    wrappedDEKRecovery: await aesGcmEncrypt(rkek, raw, 'dek-recovery'),
    updatedAt: opts.now ?? new Date().toISOString(),
  }
  delete next.keyCheck
  raw.fill(0)
  return { header: next, recoveryKey }
}

/**
 * Drop the master password. The DEK moves out to the returned local key, which
 * the caller must store beside the data; the recovery key stops working.
 */
export async function removePassword(
  header: VaultHeader,
  current: { password: string } | { recoveryKey: string },
  now = new Date().toISOString(),
): Promise<{ header: VaultHeader; localKey: string }> {
  if (header.protection !== 'password') throw new Error('Vault has no master password')
  const raw = await unwrapCurrent(header, current)
  const localKey = toBase64(raw)
  const dek = await importDek(raw)
  raw.fill(0)
  const next: VaultHeader = { ...header, protection: 'none', keyCheck: await makeKeyCheck(dek), updatedAt: now }
  delete next.kdf
  delete next.recoveryKdf
  delete next.wrappedDEK
  delete next.wrappedDEKRecovery
  return { header: next, localKey }
}

/** Re-wrap the DEK under a new password. Needs the current password or the recovery key. */
export async function changePassword(
  header: VaultHeader,
  current: { password: string } | { recoveryKey: string },
  newPassword: string,
  now = new Date().toISOString(),
): Promise<VaultHeader> {
  const raw = await unwrapCurrent(header, current)
  const kdf: KdfParams = { salt: toBase64(randomBytes(16)), iterations: header.kdf?.iterations ?? PBKDF2_ITERATIONS, hash: 'SHA-256' }
  const kek = await deriveKek(newPassword, kdf)
  const wrappedDEK = await aesGcmEncrypt(kek, raw, 'dek')
  raw.fill(0)
  return { ...header, kdf, wrappedDEK, updatedAt: now }
}

/** Issue a fresh recovery key (the old one stops working). Needs the password. */
export async function rotateRecoveryKey(
  header: VaultHeader,
  password: string,
  now = new Date().toISOString(),
): Promise<{ header: VaultHeader; recoveryKey: string }> {
  const raw = await unwrapCurrent(header, { password })
  const recoveryKey = generateRecoveryKey()
  const recoveryKdf: KdfParams = { salt: toBase64(randomBytes(16)), iterations: header.recoveryKdf?.iterations ?? PBKDF2_ITERATIONS, hash: 'SHA-256' }
  const rkek = await deriveKek(recoveryKey, recoveryKdf)
  const wrappedDEKRecovery = await aesGcmEncrypt(rkek, raw, 'dek-recovery')
  raw.fill(0)
  return { header: { ...header, recoveryKdf, wrappedDEKRecovery, updatedAt: now }, recoveryKey }
}

export async function encryptRecord(dek: CryptoKey, plaintext: string, aad: string): Promise<string> {
  return aesGcmEncrypt(dek, enc.encode(plaintext), aad)
}

export async function decryptRecord(dek: CryptoKey, payload: string, aad: string): Promise<string> {
  return dec.decode(await aesGcmDecrypt(dek, payload, aad))
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await subtle.digest('SHA-256', enc.encode(text))
  return toHex(new Uint8Array(digest))
}
