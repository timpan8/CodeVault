/**
 * Vault cryptography. Native WebCrypto only, no third-party code.
 *
 * master password --PBKDF2-SHA256--> KEK (AES-GCM-256, non-extractable)
 * recovery key    --PBKDF2-SHA256--> recovery KEK
 * DEK: 32 random bytes, wrapped (AES-GCM) by both KEKs; imported as a
 *      non-extractable AES-GCM key for record encryption.
 * Records: AES-256-GCM, fresh 96-bit IV, AAD = record type + id.
 */

export const PBKDF2_ITERATIONS = 600_000
export const FORMAT_VERSION = 1

export interface KdfParams {
  salt: string
  iterations: number
  hash: 'SHA-256'
}

export interface VaultHeader {
  formatVersion: number
  appVersion: string
  deviceId: string
  /** Monotonically increasing per write; used to detect edits from another device. */
  revision: number
  kdf: KdfParams
  recoveryKdf: KdfParams
  wrappedDEK: string
  wrappedDEKRecovery: string
  /** Example-namespace index (0 = default); switched when a real value collides. */
  namespaceIndex: number
  createdAt: string
  updatedAt: string
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

export async function unlockWithPassword(header: VaultHeader, password: string): Promise<CryptoKey> {
  const raw = await unwrapRaw(password, header.kdf, header.wrappedDEK, 'dek')
  const dek = await importDek(raw)
  raw.fill(0)
  return dek
}

export async function unlockWithRecoveryKey(header: VaultHeader, recoveryKey: string): Promise<CryptoKey> {
  const raw = await unwrapRaw(normalizeRecoveryKey(recoveryKey), header.recoveryKdf, header.wrappedDEKRecovery, 'dek-recovery')
  const dek = await importDek(raw)
  raw.fill(0)
  return dek
}

/** Re-wrap the DEK under a new password. Needs the current password or the recovery key. */
export async function changePassword(
  header: VaultHeader,
  current: { password: string } | { recoveryKey: string },
  newPassword: string,
  now = new Date().toISOString(),
): Promise<VaultHeader> {
  const raw =
    'password' in current
      ? await unwrapRaw(current.password, header.kdf, header.wrappedDEK, 'dek')
      : await unwrapRaw(normalizeRecoveryKey(current.recoveryKey), header.recoveryKdf, header.wrappedDEKRecovery, 'dek-recovery')
  const kdf: KdfParams = { salt: toBase64(randomBytes(16)), iterations: header.kdf.iterations, hash: 'SHA-256' }
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
  const raw = await unwrapRaw(password, header.kdf, header.wrappedDEK, 'dek')
  const recoveryKey = generateRecoveryKey()
  const recoveryKdf: KdfParams = { salt: toBase64(randomBytes(16)), iterations: header.recoveryKdf.iterations, hash: 'SHA-256' }
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
