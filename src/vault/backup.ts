/**
 * Encrypted backups, plaintext structure export and restore.
 *
 * A backup is the vault header plus every encrypted record, so it can be
 * opened anywhere with the master password (or the recovery key). The
 * structure export contains templates, field names, kinds and example values
 * but never a real value; the caller runs the guard over it before writing.
 */
import { serializeTemplate } from '@engine/template'
import { decryptRecord, unlockWithPassword, unlockWithRecoveryKey, type VaultHeader } from './crypto'
import type { DecodedRecord, RawRecord } from './store'
import { VaultStore } from './store'
import type { FieldRecord, RecordType, ScriptRecord, VersionRecord } from './model'

export const BACKUP_MAGIC = 'codevault-backup'
export const STRUCTURE_MAGIC = 'codevault-structure'

export interface BackupFile {
  magic: typeof BACKUP_MAGIC
  formatVersion: 1
  exportedAt: string
  header: VaultHeader
  records: RawRecord[]
}

export function buildBackup(header: VaultHeader, records: RawRecord[], now = new Date().toISOString()): BackupFile {
  return { magic: BACKUP_MAGIC, formatVersion: 1, exportedAt: now, header, records }
}

export function serializeBackup(b: BackupFile): string {
  return JSON.stringify(b)
}

export function parseBackup(text: string): BackupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not a CodeVault backup (invalid JSON)')
  }
  const b = parsed as Partial<BackupFile>
  if (b.magic !== BACKUP_MAGIC || !b.header || !Array.isArray(b.records)) throw new Error('Not a CodeVault backup')
  if ((b.formatVersion ?? 0) > 1) throw new Error('Backup was written by a newer app version')
  return b as BackupFile
}

const pad = (n: number) => String(n).padStart(2, '0')

export function backupFilename(now = new Date()): string {
  return `codevault-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.enc`
}

export function structureFilename(now = new Date()): string {
  return backupFilename(now).replace(/\.enc$/, '.structure.json')
}

export async function openBackup(
  b: BackupFile,
  secret: { password: string } | { recoveryKey: string },
): Promise<{ dek: CryptoKey; records: DecodedRecord[] }> {
  const dek = 'password' in secret ? await unlockWithPassword(b.header, secret.password) : await unlockWithRecoveryKey(b.header, secret.recoveryKey)
  const records: DecodedRecord[] = []
  for (const row of b.records) {
    const json = await decryptRecord(dek, row.payload, `${row.type}:${row.id}`)
    records.push({ id: row.id, type: row.type, scriptId: row.scriptId, updatedAt: row.updatedAt, deviceId: row.deviceId, data: JSON.parse(json) })
  }
  return { dek, records }
}

export interface RestoreTest {
  ok: true
  counts: Record<string, number>
  header: VaultHeader
  exportedAt: string
}

/** Decrypt every record in memory and report counts. Nothing is written. */
export async function testRestore(b: BackupFile, secret: { password: string } | { recoveryKey: string }): Promise<RestoreTest> {
  const { records } = await openBackup(b, secret)
  const counts: Record<string, number> = {}
  for (const r of records) counts[r.type] = (counts[r.type] ?? 0) + 1
  return { ok: true, counts, header: b.header, exportedAt: b.exportedAt }
}

/** Replace the local store with the backup (only for an empty or discarded vault). */
export async function restoreIntoStore(store: VaultStore, b: BackupFile): Promise<void> {
  await store.replaceAll(b.header, b.records)
}

export interface BackupOrigin {
  sameVault: boolean
  fromOtherDevice: boolean
  incomingRevision: number
  localRevision: number
  incomingIsNewer: boolean
}

/** Compare a backup with the local header; a newer revision from elsewhere requires a merge, never a silent overwrite. */
export function compareOrigin(local: VaultHeader | undefined, incoming: VaultHeader): BackupOrigin {
  if (!local) return { sameVault: false, fromOtherDevice: true, incomingRevision: incoming.revision, localRevision: 0, incomingIsNewer: true }
  const sameVault = local.kdf.salt === incoming.kdf.salt || local.wrappedDEKRecovery === incoming.wrappedDEKRecovery
  return {
    sameVault,
    fromOtherDevice: incoming.deviceId !== local.deviceId,
    incomingRevision: incoming.revision,
    localRevision: local.revision,
    incomingIsNewer: incoming.revision > local.revision,
  }
}

export interface StructureExport {
  magic: typeof STRUCTURE_MAGIC
  formatVersion: 1
  exportedAt: string
  deviceId: string
  scripts: Array<Pick<ScriptRecord, 'id' | 'title' | 'aiVisibleName' | 'language' | 'eol' | 'stableVersionId' | 'createdAt'>>
  versions: Array<{
    id: string
    scriptId: string
    seq: number
    parentVersionId?: string
    createdAt: string
    source: VersionRecord['source']
    template: string
    note?: string
    tags: string[]
  }>
  fields: Array<Pick<FieldRecord, 'id' | 'name' | 'kind' | 'sensitivity' | 'scope' | 'example' | 'compare' | 'template' | 'nameAnchors' | 'aliases' | 'tombstone'>>
}

export function buildStructureExport(
  input: { header: VaultHeader; scripts: ScriptRecord[]; versions: VersionRecord[]; fields: FieldRecord[] },
  now = new Date().toISOString(),
): StructureExport {
  return {
    magic: STRUCTURE_MAGIC,
    formatVersion: 1,
    exportedAt: now,
    deviceId: input.header.deviceId,
    scripts: input.scripts.map((s) => ({
      id: s.id,
      title: s.title,
      aiVisibleName: s.aiVisibleName,
      language: s.language,
      eol: s.eol,
      ...(s.stableVersionId ? { stableVersionId: s.stableVersionId } : {}),
      createdAt: s.createdAt,
    })),
    versions: input.versions.map((v) => ({
      id: v.id,
      scriptId: v.scriptId,
      seq: v.seq,
      ...(v.parentVersionId ? { parentVersionId: v.parentVersionId } : {}),
      createdAt: v.createdAt,
      source: v.source,
      template: serializeTemplate(v.segments),
      ...(v.note ? { note: v.note } : {}),
      tags: v.tags,
    })),
    fields: input.fields.map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      sensitivity: f.sensitivity,
      scope: f.scope,
      example: f.example,
      compare: f.compare,
      ...(f.template ? { template: f.template } : {}),
      nameAnchors: f.nameAnchors,
      aliases: f.aliases,
      ...(f.tombstone ? { tombstone: true } : {}),
    })),
  }
}

/** Every free-text string in the export, for the guard to scan before writing. Slot markers are neutralised first. */
export function structureExportStrings(e: StructureExport): string[] {
  const out: string[] = []
  for (const s of e.scripts) out.push(s.title, s.aiVisibleName)
  for (const v of e.versions) {
    out.push(v.template.replace(/\u27E6f:[^\u27E7]*\u27E7/g, 'SLOT'))
    if (v.note) out.push(v.note)
    out.push(...v.tags)
  }
  for (const f of e.fields) {
    out.push(f.name, f.example, ...f.nameAnchors, ...f.aliases.map((a) => a.value))
    if (f.template) out.push(f.template)
  }
  return out
}

export const RECORD_TYPES: readonly RecordType[] = ['script', 'version', 'field', 'retired', 'allowlist', 'exclusion', 'settings']

/**
 * Write a file into a directory handle (File System Access API) and prune
 * older files matching the rotation prefix so at most `keep` remain.
 * Browser only; callers fall back to a download when the API is unavailable.
 */
export async function writeRotatingFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: string,
  pattern: RegExp,
  keep = 10,
): Promise<string[]> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
  const names: string[] = []
  for await (const [entryName, entry] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (entry.kind === 'file' && pattern.test(entryName)) names.push(entryName)
  }
  names.sort()
  const removed: string[] = []
  while (names.length > keep) {
    const oldest = names.shift()!
    await dir.removeEntry(oldest)
    removed.push(oldest)
  }
  return removed
}
